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
    description: '读取工作区中的文本文件，默认按 UTF-8 解码。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于当前工作区的文件路径。' },
        encoding: { type: 'string', description: '文本编码，默认为 utf8。' },
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
    description: '把文本内容写入工作区中的文件，默认使用 UTF-8 编码。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于当前工作区的文件路径。' },
        content: { type: 'string', description: '要写入的文本内容。' },
        encoding: { type: 'string', description: '文本编码，默认为 utf8。' },
        createDirs: { type: 'boolean', description: '写入前是否创建父目录，默认为 true。' },
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
