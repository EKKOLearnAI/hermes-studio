import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { resolveToolPath } from './path-safety'

export interface ReadFileInput extends Record<string, unknown> {
  path: string
  encoding?: BufferEncoding
}

export interface WriteFileInput extends Record<string, unknown> {
  path: string
  content: string
  encoding?: BufferEncoding
  createDirs?: boolean
}

export class ReadFileTool implements AgentTool<ReadFileInput> {
  readonly definition = {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the current workspace.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }

  async execute(input: ReadFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)
    const content = await readFile(filePath, input.encoding || 'utf8')
    return {
      ok: true,
      content,
      data: {
        path: filePath,
        bytes: Buffer.byteLength(content, input.encoding || 'utf8'),
      },
    }
  }
}

export class WriteFileTool implements AgentTool<WriteFileInput> {
  readonly definition = {
    name: 'write_file',
    description: 'Write UTF-8 text content to a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the current workspace.' },
        content: { type: 'string', description: 'Text content to write.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
        createDirs: { type: 'boolean', description: 'Create parent directories before writing. Defaults to true.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  }

  async execute(input: WriteFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)
    if (input.createDirs !== false) {
      await mkdir(path.dirname(filePath), { recursive: true })
    }
    await writeFile(filePath, input.content, input.encoding || 'utf8')
    return {
      ok: true,
      content: `Wrote ${Buffer.byteLength(input.content, input.encoding || 'utf8')} bytes to ${filePath}`,
      data: {
        path: filePath,
        bytes: Buffer.byteLength(input.content, input.encoding || 'utf8'),
      },
    }
  }
}

export function createFileTools(): AgentTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
  ]
}
