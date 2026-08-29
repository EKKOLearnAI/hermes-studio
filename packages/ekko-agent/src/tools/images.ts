import { readFile, stat } from 'node:fs/promises'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { resolveToolPath } from './path-safety'
import { AgentToolError } from './types'

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface ViewImageInput extends Record<string, unknown> {
  path: string
}

export interface ViewImageToolOptions {
  maxBytes?: number
}

export class ViewImageTool implements AgentTool<ViewImageInput> {
  readonly concurrency = 'parallel' as const

  readonly definition = {
    name: 'view_image',
    description: 'Load a local PNG, JPEG, WebP, or GIF image from the workspace for visual inspection. If the current model cannot consume images, this tool returns a recoverable VISION_UNSUPPORTED failure; continue with text-based tools or explain that a vision-capable model is required.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image path relative to the current workspace, or an absolute path inside workspaceRoot.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }

  private readonly maxBytes: number

  constructor(options: ViewImageToolOptions = {}) {
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_IMAGE_BYTES)
  }

  async execute(input: ViewImageInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)
    const info = await stat(filePath)
    if (!info.isFile()) {
      throw new AgentToolError(`Image path is not a file: ${input.path}`, 'IMAGE_NOT_FILE')
    }
    if (info.size > this.maxBytes) {
      throw new AgentToolError(
        `Image exceeds the ${this.maxBytes}-byte view limit: ${input.path}`,
        'IMAGE_TOO_LARGE',
      )
    }

    const data = await readFile(filePath)
    const mimeType = detectImageMimeType(data)
    if (!mimeType) {
      throw new AgentToolError(
        `Unsupported image format: ${input.path}. Expected PNG, JPEG, WebP, or GIF.`,
        'UNSUPPORTED_IMAGE_FORMAT',
      )
    }

    if (context.modelCapabilities?.vision === false) {
      const modelLabel = [context.modelProvider, context.modelName].filter(Boolean).join('/') || 'current model'
      const error = `Image inspection is unavailable because ${modelLabel} does not support vision input.`
      return {
        ok: false,
        content: `${error} The image file itself was loaded successfully. Continue without the image, use text-based inspection tools, or ask the user to switch to a vision-capable model.`,
        error,
        data: {
          code: 'VISION_UNSUPPORTED',
          path: filePath,
          bytes: data.byteLength,
          mimeType,
          provider: context.modelProvider,
          model: context.modelName,
        },
      }
    }

    return {
      ok: true,
      content: `Loaded ${mimeType} image from ${filePath} (${data.byteLength} bytes).`,
      contentParts: [{
        type: 'image',
        data: data.toString('base64'),
        mimeType,
      }],
      data: {
        path: filePath,
        bytes: data.byteLength,
        mimeType,
      },
    }
  }
}

export function createImageTools(options: ViewImageToolOptions = {}): AgentTool[] {
  return [new ViewImageTool(options)]
}

function detectImageMimeType(data: Buffer): string | undefined {
  if (
    data.length >= 8
    && data[0] === 0x89
    && data.subarray(1, 4).toString('ascii') === 'PNG'
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}
