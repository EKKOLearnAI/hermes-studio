/**
 * Chat run via Socket.IO — namespace /chat-run.
 *
 * Replaces HTTP POST + SSE. Socket.IO decouples message handling
 * from connection lifecycle: the server continues streaming upstream
 * events even after the client disconnects or refreshes.
 *
 * Uses Socket.IO rooms keyed by session_id. On client reconnect,
 * the client emits 'resume' to rejoin its session room.
 */
import type { Server, Socket } from 'socket.io'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { extname, isAbsolute, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import { getSystemPrompt } from '../../lib/llm-prompt'
import {
  getSession,
  getSessionDetail,
  getSessionDetailPaginated,
  createSession,
  addMessage,
  updateSessionStats,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { getSessionDetailFromDb } from '../../db/hermes/sessions-db'
import { getModelContextLength } from './model-context'
import { ChatContextCompressor, countTokens, SUMMARY_PREFIX } from '../../lib/context-compressor'
import { getCompressionSnapshot } from '../../db/hermes/compression-snapshot'
import { parseAnthropicContentArray } from '../../lib/llm-json'
import { updateUsage } from '../../db/hermes/usage-store'
import { logger } from '../logger'
import { config } from '../../config'
import { getProfileDir } from './hermes-profile'
import {
  extractFeishuSessionFromCookieHeader,
  getFeishuSessionSecret,
  parseFeishuSessionCookie,
} from '../feishu-oauth'

/**
 * Content block types for Anthropic-compatible message format
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; media_type: string }
  | { type: 'file'; name: string; path: string; media_type?: string }

/**
 * Convert ContentBlock[] to string for display/storage
 * - string → 直接返回
 * - ContentBlock[] → 返回 JSON 字符串
 */
function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input

  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

const USE_CLIENT_SUPPLIED_HISTORY = process.env.HERMES_WEBUI_CLIENT_HISTORY === '1'
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.log',
])
const SPREADSHEET_FILE_EXTENSIONS = new Set(['.xlsx'])
const MAX_INLINE_FILE_CHARS = 200_000

function resolveUploadedPath(profile: string, filePath: string): string | null {
  if (!filePath) return null
  const workspaceRoot = resolve(getProfileDir(profile), 'workspace')
  if (isAbsolute(filePath)) {
    const absolutePath = resolve(filePath)
    const uploadRoot = resolve(config.uploadDir)
    const allowedRoots = [workspaceRoot, uploadRoot]
    return allowedRoots.some(root => absolutePath === root || absolutePath.startsWith(`${root}/`))
      ? absolutePath
      : null
  }
  const candidate = resolve(workspaceRoot, filePath)
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}/`)) return null
  return candidate
}

function shouldInlineFile(block: ContentBlock): boolean {
  if (block.type !== 'file') return false
  const media = (block.media_type || '').toLowerCase()
  if (media.startsWith('text/')) return true
  const extension = extname(block.name || block.path).toLowerCase()
  return TEXT_FILE_EXTENSIONS.has(extension) || SPREADSHEET_FILE_EXTENSIONS.has(extension)
}

async function readInlineFileBlock(profile: string, block: ContentBlock): Promise<string> {
  if (block.type !== 'file') return ''
  const resolvedPath = resolveUploadedPath(profile, block.path)
  if (!resolvedPath || !existsSync(resolvedPath) || !shouldInlineFile(block)) {
    return `[File: ${block.name || block.path}]`
  }
  const extension = extname(block.name || block.path).toLowerCase()
  const content = SPREADSHEET_FILE_EXTENSIONS.has(extension)
    ? extractXlsxText(await readFile(resolvedPath))
    : await readFile(resolvedPath, 'utf-8')
  if (!content) return `[File: ${block.name || block.path}]`
  const trimmed = content.length > MAX_INLINE_FILE_CHARS
    ? `${content.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at ${MAX_INLINE_FILE_CHARS} characters]`
    : content
  return `\n\n[File: ${block.name || block.path}]\n${trimmed}`
}

function extractXlsxText(file: Buffer): string {
  const entries = unzipEntries(file)
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf-8') || '')
  const lines: string[] = []
  const sheets = [...entries.keys()]
    .filter(name => name.startsWith('xl/worksheets/') && name.endsWith('.xml'))
    .sort()
    .slice(0, 3)

  for (const sheet of sheets) {
    const xml = entries.get(sheet)?.toString('utf-8') || ''
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      if (rows.length >= 50) break
      const rowXml = rowMatch[0]
      const values: string[] = []
      for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (values.length >= 20) break
        values.push(parseXlsxCell(cellMatch[1], cellMatch[2], sharedStrings))
      }
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      if (values.length > 0) rows.push(values.join('\t'))
    }
    if (rows.length > 0) {
      lines.push(`[${sheet.split('/').pop()?.replace(/\.xml$/, '') || 'sheet'}]`)
      lines.push(...rows)
    }
  }
  return lines.join('\n')
}

function unzipEntries(file: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const eocdOffset = findZipEndOfCentralDirectory(file)
  if (eocdOffset < 0) return entries
  const centralDirectorySize = file.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = file.readUInt32LE(eocdOffset + 16)
  let offset = centralDirectoryOffset
  const end = centralDirectoryOffset + centralDirectorySize
  while (offset < end && file.readUInt32LE(offset) === 0x02014b50) {
    const method = file.readUInt16LE(offset + 10)
    const compressedSize = file.readUInt32LE(offset + 20)
    const nameLength = file.readUInt16LE(offset + 28)
    const extraLength = file.readUInt16LE(offset + 30)
    const commentLength = file.readUInt16LE(offset + 32)
    const localHeaderOffset = file.readUInt32LE(offset + 42)
    const name = file.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8')
    const localNameLength = file.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = file.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = file.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.set(name, compressed)
    if (method === 8) entries.set(name, inflateRawSync(compressed))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findZipEndOfCentralDirectory(file: Buffer): number {
  for (let offset = file.length - 22; offset >= 0; offset -= 1) {
    if (file.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)]
    .map(match => [...match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(text => decodeXmlText(text[1]))
      .join(''))
}

function parseXlsxCell(attributes: string, body: string, sharedStrings: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] || ''
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map(text => decodeXmlText(text[1]))
      .join('')
  }
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] || ''
  if (type === 's') {
    const index = Number(value)
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : ''
  }
  return decodeXmlText(value)
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function buildResponsesInput(input: string | ContentBlock[], profile: string): Promise<any> {
  if (!isContentBlockArray(input)) return input

  const hasImage = input.some(block => block.type === 'image')
  if (!hasImage) {
    const parts: string[] = []
    for (const block of input) {
      if (block.type === 'text') parts.push(block.text)
      if (block.type === 'file') parts.push(await readInlineFileBlock(profile, block))
    }
    return parts.filter(Boolean).join('\n')
  }

  const parts = await convertContentBlocks(input, profile)
  return [{ role: 'user', content: parts }]
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 *
 * - text → { type: "input_text", text }
 * - image → { type: "input_image", image_url: "data:image/...;base64,..." }
 * - file → text mention [File: name]
 */
async function convertContentBlocks(blocks: ContentBlock[], profile: string): Promise<Array<{ type: string; text?: string; image_url?: string }>> {
  const parts: Array<{ type: string; text?: string; image_url?: string }> = []
  const fs = await import('fs/promises')
  const path = await import('path')

  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      try {
        const resolvedPath = resolveUploadedPath(profile, block.path)
        if (!resolvedPath) throw new Error('image path is outside allowed upload roots')
        const buf = await fs.readFile(resolvedPath)
        const ext = path.extname(resolvedPath).toLowerCase().replace('.', '')
        const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
        const base64 = buf.toString('base64')
        parts.push({ type: 'input_image', image_url: `data:image/${mime};base64,${base64}` })
      } catch {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: await readInlineFileBlock(profile, block) })
    }
  }

  return parts
}

const compressor = new ChatContextCompressor()

// --- Helper: Convert OpenAI format to Anthropic format ---
function convertHistoryFormat(messages: any[]): any[] {
  const result: any[] = []

  for (const m of messages) {
    const role = m.role
    const content = m.content || ''
    delete m.reasoning_content
    if (role === 'tool') {
      // Convert tool message to tool_result in user message
      // Follow Hermes official format: content is a string (not array)
      let pushItem = { ...m }
      pushItem.role = 'user'
      pushItem.content = `[Tool result: ${content}]`
      result.push(pushItem)
      continue
    }

    // Regular user message
    if (role === 'user') {
      // Format: { role: 'user', content: [{ type: 'text', text: '...' }] }
      if (typeof content === 'string') {
        result.push({ role: 'user', content: content })
      } else if (Array.isArray(content)) {
        // Extract text from content blocks for history
        const textParts = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
        result.push({ role: 'user', content: textParts || JSON.stringify(content) })
      }
      continue
    }
    if (role === 'assistant') {
      result.push({ ...m })
      continue
    }
  }
  return result
}

// --- Session state tracking ---

interface SessionMessage {
  id: number | string
  session_id: string
  role: string
  content: string
  runMarker?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  model?: string
  provider?: string
  instructions?: string
  profile: string
}

interface SessionState {
  messages: SessionMessage[]
  isWorking: boolean
  events: Array<{ event: string; data: any }>
  abortController?: AbortController
  runId?: string
  profile?: string
  inputTokens?: number
  outputTokens?: number
  isAborting?: boolean
  queue: QueuedRun[]
  responseRun?: ResponseRunState
}

interface ResponseRunState {
  runMarker?: string
  responseId?: string
  insertedKeys: Set<string>
  toolCalls: Map<string, any>
}

function buildBrokerMessagesForSession(messages: SessionMessage[]): Array<Record<string, any>> {
  const brokerMessages: Array<Record<string, any>> = []
  for (const message of messages) {
    const role = message.role
    const content = typeof message.content === 'string' ? message.content : String(message.content || '')
    if (role === 'user') {
      if (content.trim()) brokerMessages.push({ role: 'user', content })
      continue
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (content.trim()) {
        brokerMessages.push({ role: 'assistant', content })
      } else if (toolCalls.length) {
        brokerMessages.push({ role: 'assistant', content: '', tool_calls: toolCalls })
      }
      continue
    }
    if (role === 'tool' && content.trim()) {
      brokerMessages.push({
        role: 'user',
        content: `[Tool result: ${content}]`,
      })
    }
  }
  return brokerMessages
}

function brokerToolIdPart(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).trim()
  return (text || fallback).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || fallback
}

function brokerToolCallId(parsed: any, payload: any, runId: unknown, toolName: unknown): string {
  const explicit = parsed?.tool_call_id || payload.tool_call_id || parsed?.call_id || payload.call_id
  if (explicit) return String(explicit)
  const index = parsed?.index ?? payload.index ?? parsed?.tool_index ?? payload.tool_index
  const suffix = index != null ? `_${brokerToolIdPart(index, '0')}` : ''
  return `broker_tool_${brokerToolIdPart(runId, 'run')}_${brokerToolIdPart(toolName, 'tool')}${suffix}`
}

type RunBrokerChatFrameMapping =
  | {
      type: 'emit'
      event: string
      payload: any
      appendFinalText: boolean
      persistAssistantContent: boolean
    }
  | { type: 'terminal'; event: 'run.completed' | 'run.failed'; payload: any }
  | { type: 'ignore' }

export function mapRunBrokerFrameForChat(parsed: any, frameEvent?: string): RunBrokerChatFrameMapping {
  const payload = parsed?.payload || {}
  const brokerKind = parsed?.kind || parsed?.event || frameEvent
  const runId = parsed?.run_id || parsed?.runId || payload.run_id
  const responseId = runId

  if (brokerKind === 'content' || brokerKind === 'message.delta') {
    const deltaText = parsed?.text || parsed?.delta || payload.text || payload.delta || ''
    if (!deltaText) return { type: 'ignore' }
    return {
      type: 'emit',
      event: 'message.delta',
      appendFinalText: true,
      persistAssistantContent: true,
      payload: {
        event: 'message.delta',
        run_id: runId,
        response_id: responseId,
        delta: deltaText,
      },
    }
  }

  if (brokerKind === 'thinking' || brokerKind === 'reasoning.delta' || brokerKind === 'thinking.delta') {
    const deltaText = parsed?.text || parsed?.delta || payload.text || payload.delta || ''
    if (!deltaText) return { type: 'ignore' }
    if (
      deltaText === '正在连接模型和工具运行环境...' ||
      deltaText === '仍在等待模型或工具返回...'
    ) {
      return { type: 'ignore' }
    }
    return {
      type: 'emit',
      event: 'reasoning.delta',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'reasoning.delta',
        run_id: runId,
        response_id: responseId,
        delta: deltaText,
        text: deltaText,
      },
    }
  }

  if (brokerKind === 'tool_started' || brokerKind === 'tool.started') {
    const toolName = parsed?.name || parsed?.tool || payload.name || payload.tool
    let args = parsed?.arguments ?? parsed?.args ?? payload.arguments ?? payload.args
    if (args != null && typeof args !== 'string') args = JSON.stringify(args)
    const preview = parsed?.preview || payload.preview || summarizeToolArguments(args || '')
    if (shouldPersistToolPreviewAsArgs(args, preview)) {
      const key = ['terminal', 'execute_code', 'lark_cli'].includes(String(toolName || '')) ? 'cmd' : 'preview'
      args = JSON.stringify({ [key]: String(preview).trim() })
    }
    const toolCallId = brokerToolCallId(parsed, payload, runId, toolName)
    return {
      type: 'emit',
      event: 'tool.started',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'tool.started',
        run_id: runId,
        response_id: responseId,
        tool_call_id: toolCallId,
        tool: toolName,
        name: toolName,
        arguments: args,
        preview,
      },
    }
  }

  if (brokerKind === 'tool_completed' || brokerKind === 'tool.completed') {
    const toolName = parsed?.name || parsed?.tool || payload.name || payload.tool
    const isError = parsed?.is_error ?? payload.is_error ?? (typeof parsed?.error === 'string' || typeof payload.error === 'string')
    const toolCallId = brokerToolCallId(parsed, payload, runId, toolName)
    return {
      type: 'emit',
      event: 'tool.completed',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: {
        event: 'tool.completed',
        run_id: runId,
        response_id: responseId,
        tool_call_id: toolCallId,
        tool: toolName,
        name: toolName,
        output: parsed?.output ?? parsed?.text ?? payload.output ?? payload.text,
        duration: parsed?.duration ?? payload.duration,
        error: parsed?.error ?? payload.error ?? isError,
        is_error: isError,
      },
    }
  }

  if (brokerKind === 'done' || brokerKind === 'run.completed') {
    return {
      type: 'terminal',
      event: 'run.completed',
      payload: {
        event: 'run.completed',
        run_id: runId,
        response_id: responseId,
        output: parsed?.text || payload.output,
        usage: payload.usage ?? parsed?.usage,
      },
    }
  }

  if (brokerKind === 'error' || brokerKind === 'run.failed') {
    return {
      type: 'terminal',
      event: 'run.failed',
      payload: {
        event: 'run.failed',
        run_id: runId,
        response_id: responseId,
        output: parsed?.text || payload.output,
        usage: payload.usage ?? parsed?.usage,
        error: parsed?.error || payload.error,
      },
    }
  }

  return { type: 'ignore' }
}

// --- ChatRunSocket ---

export class ChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private gatewayManager: any
  /** sessionId → session state (messages, working status, events, run tracking) */
  private sessionMap = new Map<string, SessionState>()
  private hermesSessionIds = new Map<string, string>()

  constructor(io: Server, gatewayManager: any) {
    this.nsp = io.of('/chat-run')
    this.gatewayManager = gatewayManager
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[chat-run-socket] Socket.IO ready at /chat-run')
  }

  // --- Auth middleware ---

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    if (config.authMode === 'feishu-oauth-dev') {
      const sessionCookie = extractFeishuSessionFromCookieHeader(socket.handshake.headers?.cookie)
      const user = parseFeishuSessionCookie(sessionCookie, { secret: getFeishuSessionSecret() })
      if (!user) return next(new Error('Authentication failed'))
      socket.data.user = user
      socket.data.profile = user.profile
      return next()
    }

    const token = socket.handshake.auth?.token as string | undefined
    if (!process.env.AUTH_DISABLED && process.env.AUTH_DISABLED !== '1') {
      const { getToken } = await import('../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  // --- Connection handler ---

  private onConnection(socket: Socket) {
    const profile = (socket.data?.profile as string | undefined) || (socket.handshake.query?.profile as string) || 'default'

    socket.on('run', async (data: {
      input: string | ContentBlock[]
      session_id?: string
      model?: string
      provider?: string
      instructions?: string
      queue_id?: string
    }) => {
      if (data.session_id) {
        const state = this.getOrCreateSession(data.session_id)
        if (state.isWorking) {
          state.queue.push({
            queue_id: data.queue_id || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            input: data.input,
            model: data.model,
            provider: data.provider,
            instructions: data.instructions,
            profile,
          })
          this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
            event: 'run.queued',
            session_id: data.session_id,
            queue_length: state.queue.length,
          })
          logger.info('[chat-run-socket] queued run for session %s (queue: %d)', data.session_id, state.queue.length)
          return
        }
      }
      await this.handleRun(socket, data, profile)
    })

    socket.on('cancel_queued_run', (data: { session_id?: string; queue_id?: string }) => {
      if (!data.session_id || !data.queue_id) return
      const state = this.sessionMap.get(data.session_id)
      if (!state?.queue.length) return
      const before = state.queue.length
      state.queue = state.queue.filter(item => item.queue_id !== data.queue_id)
      if (state.queue.length === before) return
      this.nsp.to(`session:${data.session_id}`).emit('run.queued', {
        event: 'run.queued',
        session_id: data.session_id,
        queue_length: state.queue.length,
      })
      logger.info('[chat-run-socket] cancelled queued run %s for session %s (queue: %d)',
        data.queue_id, data.session_id, state.queue.length)
    })

    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      const room = `session:${sid}`
      socket.join(room)
      this.resumeSession(socket, sid)
    })

    socket.on('abort', (data: { session_id?: string }) => {
      if (data.session_id) {
        void this.handleAbort(socket, data.session_id)
      }
    })
  }
  private handleMessage(messages: SessionMessage[], sid: string): any[] {
    let _messages = []
    try {
      _messages = messages
        .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined)
        .map((m, idx, arr) => {
          const msg: any = {
            id: m.id,
            session_id: sid,
            role: m.role,
            content: m.content || '',
            reasoning: m.reasoning || '',
            timestamp: m.timestamp,
          }
          // Convert Anthropic format content to OpenAI format
          // Check if content is a stringified array (Hermes Gateway behavior) - only for assistant messages
          if (m.role === 'assistant' && typeof m.content === 'string') {
            // Handle double-serialized content: "[{'type': 'text', ...}]" -> "[{'type': 'text', ...}]"
            let contentToParse = m.content
            const trimmed = m.content.trim()
            if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
              contentToParse = trimmed.slice(1, -1)
              logger.info('[chat-run-socket] resume message %s: double-serialized, removed outer quotes', m.id)
            }

            if (contentToParse.startsWith('[') && contentToParse.endsWith(']')) {
              try {
                // Use robust LLM JSON parser
                const parsedContent = parseAnthropicContentArray(contentToParse)
                const textBlocks: string[] = []
                const toolCalls: any[] = []
                let reasoningContent: string | null = null

                for (const block of parsedContent) {
                  if (block.type === 'thinking') {
                    reasoningContent = block.thinking || null
                  } else if (block.type === 'text') {
                    textBlocks.push(block.text || '')
                  } else if (block.type === 'tool_use') {
                    toolCalls.push({
                      id: block.id,
                      type: 'function',
                      function: {
                        name: block.name,
                        arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : (block.input ?? '{}')
                      }
                    })
                  }
                }

                msg.content = textBlocks.join('') || ''
                if (toolCalls.length > 0) {
                  msg.tool_calls = toolCalls
                }
                if (reasoningContent) {
                  msg.reasoning = reasoningContent
                }
              } catch (e) {
                logger.warn(e, '[chat-run-socket] failed to parse array content for message %s, keeping original', m.id)
                // Parsing failed, keep original content
                msg.content = m.content
              }
            }
          } else if (Array.isArray(m.content)) {
            const textBlocks: string[] = []
            const toolCalls: any[] = []
            let reasoningContent: string | null = null

            for (const block of m.content) {
              if (block.type === 'thinking') {
                reasoningContent = block.thinking
              } else if (block.type === 'text') {
                textBlocks.push(block.text)
              } else if (block.type === 'tool_use') {
                toolCalls.push({
                  id: block.id,
                  type: 'function',
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {})
                  }
                })
              }
            }

            msg.content = textBlocks.join('') || ''
            if (toolCalls.length > 0) {
              msg.tool_calls = toolCalls
            }
            if (reasoningContent) {
              msg.reasoning = reasoningContent
            }
          }

          if (m.tool_calls?.length) {
            // Filter out tool_calls with empty/invalid id and remove internal fields
            const cleanedToolCalls = m.tool_calls
              .filter((tc: any) => tc.id && tc.id.length > 0)
              .map((tc: any) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function
              }))
            if (cleanedToolCalls.length > 0) {
              msg.tool_calls = cleanedToolCalls
            }
          }

          // For tool messages, ensure tool_call_id exists
          if (m.role === 'tool') {
            let callId = m.tool_call_id
            if (!callId || callId.length === 0) {
              // Try to reconstruct tool_call_id from previous assistant message
              const prevMsg = arr[idx - 1]
              if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
                // Find matching tool_call by tool_name
                const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
                if (tc?.id) {
                  callId = tc.id
                }
              }
            }
            // Skip tool message if no valid tool_call_id
            if (!callId || callId.length === 0) {
              return null
            }
            msg.tool_call_id = callId
          }

          if (m.tool_name) msg.tool_name = m.tool_name
          if (m.reasoning) msg.reasoning = m.reasoning
          return msg
        })
        .filter(m => m !== null)
    } catch (error) {

    }
    return _messages
  }
  private async resumeSession(socket: Socket, sid: string) {
    let state = this.sessionMap.get(sid)
    if (!state) {
      state = await this.loadSessionStateFromDb(sid)
      this.sessionMap.set(sid, state)
    }
    socket.emit('resumed', {
      session_id: sid,
      messages: state.messages,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: state.isWorking ? state.events : [],
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      queueLength: state.queue?.length || 0,
    })

    logger.info('[chat-run-socket] socket %s resumed session %s (working: %s, messages: %d)',
      socket.id, sid, state.isWorking, state.messages.length)
  }

  private async loadSessionStateFromDb(sid: string): Promise<SessionState> {
    try {
      const detail = useLocalSessionStore()
        ? getSessionDetailPaginated(sid)
        : await getSessionDetailFromDb(sid)
      const messages = detail?.messages ? this.handleMessage(detail.messages, sid) : []

      let inputTokens: number
      let outputTokens: number
      const snapshot = getCompressionSnapshot(sid)
      if (snapshot) {
        const newMessages = messages.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = messages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = messages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }

      logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
      return {
        messages,
        isWorking: false,
        events: [],
        inputTokens,
        outputTokens,
        queue: [],
      }
    } catch (err) {
      logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
      return { messages: [], isWorking: false, events: [], queue: [] }
    }
  }
  // --- Run handler ---

  private async handleRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; instructions?: string },
    profile: string,
    skipUserMessage = false,
  ) {
    const { input, session_id, model, provider, instructions } = data

    // Local marker used only to group in-memory messages for this streamed response.
    const runMarker = session_id
      ? `resp_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : undefined

    const now = Math.floor(Date.now() / 1000)
    // Mark working immediately on run start, and append user message
    if (session_id) {
      let state = this.sessionMap.get(session_id)
      if (!state) {
        state = getSession(session_id)
          ? await this.loadSessionStateFromDb(session_id)
          : { messages: [], isWorking: false, events: [], queue: [] }
        this.sessionMap.set(session_id, state)
      }
      state.isWorking = true
      state.profile = profile

      if (!skipUserMessage) {
        // Convert ContentBlock[] to string for storage
        const inputStr = contentBlocksToString(input)
        state.messages.push({
          id: state.messages.length + 1,
          session_id,
          runMarker,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })

        // Create session in local DB if it doesn't exist
        if (!getSession(session_id)) {
          const previewText = extractTextForPreview(input)
          const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
          createSession({ id: session_id, profile, model, title: preview })
        }

        // Write user message to local DB immediately
        addMessage({
          session_id,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
      } else {
        // Dequeued: write the user message into both memory and DB so the
        // backend transcript keeps the same run boundary as the client.
        const inputStr = contentBlocksToString(input)
        state.messages.push({
          id: state.messages.length + 1,
          session_id,
          runMarker,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
        if (!getSession(session_id)) {
          const previewText = extractTextForPreview(input)
          const preview = previewText.replace(/[\r\n]/g, ' ').substring(0, 100)
          createSession({ id: session_id, profile, model, title: preview })
        }
        addMessage({
          session_id,
          role: 'user',
          content: inputStr,
          timestamp: now,
        })
      }

      socket.join(`session:${session_id}`)
    }

    // Emit helper: tag every payload with session_id
    const emit = (event: string, payload: any) => {
      const tagged = session_id ? { ...payload, session_id } : payload
      if (session_id) {
        this.nsp.to(`session:${session_id}`).emit(event, tagged)
      } else if (socket.connected) {
        socket.emit(event, tagged)
      }
    }
    if (config.webuiRunBroker) {
      await this.handleBrokerRun(socket, {
        input,
        session_id,
        model,
        provider,
        instructions,
      }, profile, runMarker, emit)
      return
    }

    await this.ensureGatewayReady(profile)
    const upstream = this.gatewayManager.getUpstream(profile).replace(/\/$/, '')
    const apiKey = this.gatewayManager.getApiKey(profile) || undefined

    try {
      // Build upstream request body
      const body: Record<string, any> = { input: await buildResponsesInput(input, profile) }
      if (model) body.model = model
      if (provider) body.provider = provider
      if (session_id) body.conversation = `webui:${session_id}`
      if (instructions) {
        body.instructions = `${getSystemPrompt()}\n${instructions}`
      } else {
        body.instructions = getSystemPrompt()
      }
      // Inject workspace context if set for this session
      if (session_id) {
        const sessionRow = getSession(session_id)
        if (sessionRow?.workspace) {
          const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
          body.instructions = body.instructions
            ? `\n${workspaceCtx}\n${body.instructions}`
            : `\n${workspaceCtx}`
        }
      }
      // Legacy opt-in path for stateless upstreams. Default is Hermes-native
      // response chaining via conversation/previous_response_id so the profile
      // gateway owns transcript continuity.
      if (USE_CLIENT_SUPPLIED_HISTORY && session_id) {
        try {
          const detail = useLocalSessionStore()
            ? getSessionDetail(session_id)
            : await getSessionDetailFromDb(session_id, profile)
          if (detail?.messages?.length) {
            // Filter valid messages
            const validMessages = detail.messages.filter(m =>
              (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.content !== undefined
            )

            // Exclude the last user message (just added in handleRun)
            const lastUserMsgIndex = [...validMessages].reverse().findIndex(m => m.role === 'user')
            let history: Array<{
              role: string
              content: string
              tool_calls?: any[]
              tool_call_id?: string
              name?: string
              reasoning_content?: string | null
            }> = (lastUserMsgIndex >= 0
              ? validMessages.slice(0, validMessages.length - lastUserMsgIndex - 1)
              : validMessages
            ).map((m, idx, arr) => {
              const msg: any = { role: m.role, content: m.content || '' }
              if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
              if (m.tool_calls?.length) {
                // Filter out tool_calls with empty/invalid id and remove internal fields
                const cleanedToolCalls = m.tool_calls
                  .filter((tc: any) => tc.id && tc.id.length > 0)
                  .map((tc: any) => ({
                    id: tc.id,
                    type: tc.type,
                    function: tc.function
                  }))
                if (cleanedToolCalls.length > 0) {
                  msg.tool_calls = cleanedToolCalls
                }
              }

              // For tool messages, ensure tool_call_id exists
              if (m.role === 'tool') {
                let callId = m.tool_call_id
                if (!callId || callId.length === 0) {
                  // Try to reconstruct tool_call_id from previous assistant message
                  const prevMsg = arr[idx - 1]
                  if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
                    const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
                    if (tc?.id) {
                      callId = tc.id
                    }
                  }
                }
                // Skip tool message if no valid tool_call_id
                if (!callId || callId.length === 0) {
                  return null
                }
                msg.tool_call_id = callId
              }

              if (m.tool_name) msg.name = m.tool_name
              return msg
            })
              .filter(m => m !== null)
            // Context compression with snapshot awareness
            const contextLength = getModelContextLength(profile)
            const triggerTokens = Math.floor(contextLength / 2)
            const cState = this.getOrCreateSession(session_id)

            // Calculate inputTokens + outputTokens from DB (unified method)
            const assembledTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
            const totalTokens = assembledTokens.inputTokens + assembledTokens.outputTokens
            // Step 1: Check existing snapshot — if present, assemble summary + new messages
            const snapshot = session_id ? getCompressionSnapshot(session_id) : null
            if (snapshot) {
              const newMessages = history.slice(snapshot.lastMessageIndex + 1)
              logger.info('[context-compress] session=%s: snapshot at %d, %d new messages, assembled ~%d tokens (threshold %d)',
                session_id, snapshot.lastMessageIndex, newMessages.length, totalTokens, triggerTokens)
              // triggerTokens
              if (totalTokens <= triggerTokens && newMessages.length <= 150) {
                // Under threshold — use assembled context directly, no LLM call needed
                history = [
                  { role: 'user', content: SUMMARY_PREFIX + '\n\n' + snapshot.summary },
                  ...newMessages,
                ]
              } else {
                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: totalTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: newMessages.length,
                  token_count: totalTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id,
                  )
                  const afterTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, afterTokens.inputTokens + afterTokens.outputTokens, totalTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => {
                    const msg: any = {
                      role: m.role,
                      content: m.content,
                      tool_call_id: m.tool_call_id,
                      name: m.name,
                    }
                    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
                    // Filter tool_calls if present, remove internal fields
                    if (m.tool_calls?.length) {
                      const cleanedToolCalls = m.tool_calls
                        .filter((tc: any) => tc.id && tc.id.length > 0)
                        .map((tc: any) => ({
                          id: tc.id,
                          type: tc.type,
                          function: tc.function
                        }))
                      if (cleanedToolCalls.length > 0) {
                        msg.tool_calls = cleanedToolCalls
                      }
                    }
                    return msg
                  })
                  // Update usage from DB (snapshot now updated by compressor)
                  await this.calcAndUpdateUsage(session_id, cState, emit)
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using assembled context', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: newMessages.length,
                    resultMessages: newMessages.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: newMessages.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            } else if (history.length > 4) {
              // No snapshot — check if raw history exceeds threshold

              if (totalTokens <= triggerTokens && history.length <= 150) {
                // Under threshold — use raw history as-is
                logger.info('[context-compress] session=%s: %d messages, ~%d tokens — under threshold, skip', session_id, history.length, totalTokens)
              } else {
                // Over threshold — full LLM compression
                logger.info('[context-compress] BEFORE session=%s: %d messages, ~%d tokens (threshold %d)', session_id, history.length, totalTokens, triggerTokens)

                this.pushState(session_id, 'compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: totalTokens,
                })
                emit('compression.started', {
                  event: 'compression.started',
                  message_count: history.length,
                  token_count: totalTokens,
                })

                try {
                  const result = await compressor.compress(
                    history, upstream, apiKey, session_id,
                  )
                  const cState = this.getOrCreateSession(session_id)
                  const afterTokens = await this.calcAndUpdateUsage(session_id, cState, emit)
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })
                  logger.info('[context-compress] AFTER  session=%s: %d messages, ~%d tokens (was %d)', session_id, result.messages.length, afterTokens.inputTokens + afterTokens.outputTokens, totalTokens)

                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: result.meta.compressed,
                    llmCompressed: result.meta.llmCompressed,
                    totalMessages: result.meta.totalMessages,
                    resultMessages: result.messages.length,
                    beforeTokens: totalTokens,
                    afterTokens: afterTokens.inputTokens + afterTokens.outputTokens,
                    summaryTokens: result.meta.summaryTokenEstimate,
                    verbatimCount: result.meta.verbatimCount,
                    compressedStartIndex: result.meta.compressedStartIndex,
                  })

                  history = result.messages.map(m => {
                    const msg: any = {
                      role: m.role,
                      content: m.content,
                      tool_call_id: m.tool_call_id,
                      name: m.name,
                    }
                    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
                    // Filter tool_calls if present, remove internal fields
                    if (m.tool_calls?.length) {
                      const cleanedToolCalls = m.tool_calls
                        .filter((tc: any) => tc.id && tc.id.length > 0)
                        .map((tc: any) => ({
                          id: tc.id,
                          type: tc.type,
                          function: tc.function
                        }))
                      if (cleanedToolCalls.length > 0) {
                        msg.tool_calls = cleanedToolCalls
                      }
                    }
                    return msg
                  })
                  await this.calcAndUpdateUsage(session_id, cState, emit)
                } catch (err: any) {
                  this.replaceState(session_id, 'compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                  logger.warn(err, '[chat-run-socket] compression failed for session %s, using raw history', session_id)
                  emit('compression.completed', {
                    event: 'compression.completed',
                    compressed: false,
                    totalMessages: history.length,
                    resultMessages: history.length,
                    beforeTokens: totalTokens,
                    afterTokens: totalTokens,
                    summaryTokens: 0,
                    verbatimCount: history.length,
                    compressedStartIndex: -1,
                    error: err.message,
                  })
                }
              }
            }

            body.conversation_history = history
          }
        } catch (err) {
          logger.warn(err, '[chat-run-socket] failed to load conversation history for session %s', session_id)
        }
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const userOpenId = (socket.data?.user?.openid as string | undefined)?.trim()
      if (userOpenId) headers['X-Hermes-Feishu-OpenId'] = userOpenId
      // Convert conversation_history from OpenAI format to Anthropic format
      if (body.conversation_history && Array.isArray(body.conversation_history)) {
        body.conversation_history = convertHistoryFormat(body.conversation_history)
      }
      body.stream = true
      body.store = true

      const abortController = new AbortController()
      if (session_id) {
        const state = this.getOrCreateSession(session_id)
        state.isWorking = true
        state.runId = undefined
        state.abortController = abortController
      }

      const res = await fetch(`${upstream}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: `Upstream ${res.status}: ${text}`, queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }
      if (!res.body) {
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: 'Upstream response stream missing', queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }
      const hermesSessionId = res.headers.get('X-Hermes-Session-Id') || res.headers.get('x-hermes-session-id')
      if (session_id && hermesSessionId) this.hermesSessionIds.set(session_id, hermesSessionId)

      let responseId: string | undefined
      for await (const frame of readSseFrames(res.body)) {
        let parsed: any
        try {
          parsed = JSON.parse(frame.data)
        } catch {
          continue
        }
        const upstreamEvent = parsed.type || frame.event || parsed.event
        logger.info('[chat-run-socket] upstream response event: %s', upstreamEvent)

        if (session_id) {
          const state = this.sessionMap.get(session_id)
          if (state) {
            const mapped = this.applyResponseStreamEvent(state, session_id, runMarker, upstreamEvent, parsed)
            if (mapped) {
              if (mapped.runId) {
                responseId = mapped.runId
                state.runId = responseId
              }
              emit(mapped.event, mapped.payload)
            }
          }
        }

        if (upstreamEvent === 'response.completed' || upstreamEvent === 'response.failed') {
          if (session_id && this.sessionMap.get(session_id)?.isAborting) {
            logger.info({
              sessionId: session_id,
              runId: responseId,
              event: upstreamEvent,
            }, '[chat-run-socket][abort] suppressing upstream terminal event during abort')
            return
          }
          const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
          if (session_id) await this.markCompleted(socket, session_id, {
            event: upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed',
            run_id: responseId,
          })
          const finalOutput = parsed.response || parsed
          const completedHermesSessionId = finalOutput.session_id || finalOutput.sessionId || hermesSessionId
          if (session_id && completedHermesSessionId) this.hermesSessionIds.set(session_id, String(completedHermesSessionId))
          const finalText = extractResponseText(finalOutput)
          if (upstreamEvent === 'response.completed' && session_id) {
            const usage = finalOutput.usage || {}
            updateUsage(session_id, {
              inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
              outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
              cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
              reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
              model: finalOutput.model || '',
              profile: this.sessionMap.get(session_id)?.profile,
            })
          }
          const eventName = upstreamEvent === 'response.completed' ? 'run.completed' : 'run.failed'
          emit(eventName, {
            event: eventName,
            run_id: responseId || finalOutput.id,
            response_id: responseId || finalOutput.id,
            output: finalText,
            usage: finalOutput.usage,
            error: finalOutput.error || parsed.error,
            queue_remaining: queueLen,
          })
          if (session_id && queueLen > 0) {
            this.dequeueNextQueuedRun(socket, session_id)
          }
          return
        }
      }
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed', run_id: responseId })
      emit('run.failed', {
        event: 'run.failed',
        run_id: responseId,
        response_id: responseId,
        error: 'Response stream ended without a terminal event',
        queue_remaining: queueLen,
      })
      if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
    } catch (err: any) {
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) {
        void this.markCompleted(socket, session_id, { event: 'run.failed' }).then(() => {
          emit('run.failed', { event: 'run.failed', error: err.message, queue_remaining: queueLen })
          if (queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        })
      } else {
        emit('run.failed', { event: 'run.failed', error: err.message })
      }
    }
  }

  private applyResponseStreamEvent(
    state: SessionState,
    sessionId: string,
    runMarker: string | undefined,
    eventType: string,
    parsed: any,
  ): { event: string; payload: any; runId?: string } | null {
    const run = this.getResponseRunState(state, runMarker)
    const now = () => Math.floor(Date.now() / 1000)

    if (eventType === 'response.created') {
      const response = parsed.response || parsed
      run.responseId = response.id || run.responseId
      return {
        event: 'run.started',
        runId: run.responseId,
        payload: {
          event: 'run.started',
          run_id: run.responseId,
          response_id: run.responseId,
          status: response.status || 'in_progress',
          queue_length: state.queue.length || 0,
        },
      }
    }

    if (eventType === 'response.output_text.delta') {
      const deltaText = parsed.delta || parsed.text || ''
      if (!deltaText) return null

      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
        last.content += deltaText
      } else {
        state.messages.push({
          id: state.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: deltaText,
          timestamp: now(),
        })
      }
      return {
        event: 'message.delta',
        payload: {
          event: 'message.delta',
          run_id: run.responseId,
          response_id: run.responseId,
          delta: deltaText,
        },
      }
    }

    if (eventType === 'response.output_text.done') {
      // Just mark the last assistant message as complete.
      // Content is already accumulated correctly via deltas.
      const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
      if (last?.role === 'assistant' && last.finish_reason == null) {
        last.finish_reason = 'stop'
      }
      return null
    }

    if (eventType === 'response.output_item.added') {
      const item = parsed.item || parsed.output_item || parsed
      if (item.type !== 'function_call') return null
      const callId = item.call_id || item.id
      if (!callId) return null
      run.toolCalls.set(callId, responseFunctionCallToToolCall(item))
      return null
    }

    if (eventType === 'response.output_item.done') {
      const item = parsed.item || parsed.output_item || parsed
      if (item.type === 'function_call') {
        const callId = item.call_id || item.id
        if (!callId) return null
        const toolCall = responseFunctionCallToToolCall(item)
        run.toolCalls.set(callId, toolCall)

        const key = `assistant:${callId}`
        if (!run.insertedKeys.has(key)) {
          run.insertedKeys.add(key)
          state.messages.push({
            id: state.messages.length + 1,
            session_id: sessionId,
            runMarker,
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
            timestamp: now(),
          })
        }
        return {
          event: 'tool.started',
          payload: {
            event: 'tool.started',
            run_id: run.responseId,
            response_id: run.responseId,
            tool_call_id: callId,
            tool: toolCall.function.name,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            preview: summarizeToolArguments(toolCall.function.arguments),
          },
        }
      }

      if (item.type === 'function_call_output') {
        const callId = item.call_id || item.id
        if (!callId) return null
        const key = `tool:${callId}`
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        const toolName = run.toolCalls.get(callId)?.function?.name || null
        if (!run.insertedKeys.has(key)) {
          run.insertedKeys.add(key)
          state.messages.push({
            id: state.messages.length + 1,
            session_id: sessionId,
            runMarker,
            role: 'tool',
            content: output,
            tool_call_id: callId,
            tool_name: toolName,
            timestamp: now(),
          })
        }
        return {
          event: 'tool.completed',
          payload: {
            event: 'tool.completed',
            run_id: run.responseId,
            response_id: run.responseId,
            tool_call_id: callId,
            tool: toolName,
            name: toolName,
            output,
          },
        }
      }
    }

    if (eventType === 'response.completed') {
      const response = parsed.response || parsed
      run.responseId = response.id || run.responseId
      const output = Array.isArray(response.output) ? response.output : []
      for (const item of output) {
        if (item.type === 'function_call') {
          this.applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
        } else if (item.type === 'function_call_output') {
          this.applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
        }
      }
    }

    return null
  }

  private getResponseRunState(state: SessionState, runMarker?: string): ResponseRunState {
    if (!state.responseRun || state.responseRun.runMarker !== runMarker) {
      state.responseRun = {
        runMarker,
        insertedKeys: new Set<string>(),
        toolCalls: new Map<string, any>(),
      }
    }
    return state.responseRun
  }

  /** Flush all non-user messages for this run to DB in order. */
  private flushResponseRunToDb(state: SessionState, sessionId: string) {
    const run = state.responseRun
    if (!run?.runMarker) return
    let flushed = 0
    for (const msg of state.messages) {
      if (msg.runMarker !== run.runMarker) continue
      if (msg.role === 'user') continue
      addMessage({
        session_id: sessionId,
        role: msg.role,
        content: msg.content || '',
        tool_call_id: msg.tool_call_id ?? null,
        tool_calls: msg.tool_calls ?? null,
        tool_name: msg.tool_name ?? null,
        finish_reason: msg.finish_reason ?? null,
        reasoning: msg.reasoning ?? null,
        reasoning_details: msg.reasoning_details ?? null,
        reasoning_content: msg.reasoning_content ?? null,
        timestamp: msg.timestamp,
      })
      flushed++
    }
    logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s',
      flushed, sessionId)
  }

  // --- Abort handler ---

  private async handleAbort(socket: Socket, sessionId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state?.isWorking || (!state.runId && !state.abortController)) {
      logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
      if (state) {
        state.isWorking = false
        state.isAborting = false
        state.abortController = undefined
        state.runId = undefined
        state.events = []
      }
      this.emitToSession(socket, sessionId, 'abort.completed', {
        event: 'abort.completed',
        synced: false,
        ignored: true,
      })
      return
    }

    const runId = state.runId
    state.isAborting = true
    this.replaceState(sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    this.emitToSession(socket, sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: runId,
      graceMs: 5000,
    })
    logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

    // Flush in-memory assistant text to DB before aborting the stream.
    this.flushResponseRunToDb(state, sessionId)

    if (state.abortController) {
      state.abortController.abort()
    }

    await this.markAbortCompleted(socket, sessionId, runId || 'response_stream')
  }

  /** Mark a session run as completed/failed so reconnecting clients get notified */
  private async markCompleted(socket: Socket, sessionId: string, _info: { event: string; run_id?: string }) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      if (state.isAborting) {
        logger.info({
          sessionId,
          runId: state.runId,
        }, '[chat-run-socket][abort] terminal upstream event observed; abort handler will finish cleanup')
        return
      }
      state.isWorking = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
      this.flushResponseRunToDb(state, sessionId)
      const profile = state.profile
      const hermesSessionId = this.hermesSessionIds.get(sessionId)
      if (profile && hermesSessionId) {
        void this.syncFromHermes(socket, sessionId, hermesSessionId, profile, { maxAttempts: 10, delayMs: 500 })
      }
      state.responseRun = undefined
      state.profile = undefined
      updateSessionStats(sessionId)
      const emit = (event: string, payload: any) => {
        this.nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
      }
      await this.calcAndUpdateUsage(sessionId, state, emit)
    }
  }

  private dequeueNextQueuedRun(socket: Socket, sessionId: string, fallbackProfile = 'default') {
    const state = this.sessionMap.get(sessionId)
    if (!state?.queue.length) return false

    const next = state.queue.shift()!
    logger.info('[chat-run-socket] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    this.nsp.to(`session:${sessionId}`).emit('run.queued', {
      event: 'run.queued',
      session_id: sessionId,
      queue_length: state.queue.length,
    })
    void this.handleRun(socket, {
      input: next.input,
      session_id: sessionId,
      model: next.model,
      provider: next.provider,
      instructions: next.instructions,
    }, next.profile || fallbackProfile, true)
    return true
  }

  private async markAbortCompleted(socket: Socket, sessionId: string, runId: string) {
    const state = this.sessionMap.get(sessionId)
    if (!state) return

    const profile = state.profile
    updateSessionStats(sessionId)

    state.isWorking = false
    state.isAborting = false
    state.profile = undefined
    state.abortController = undefined
    state.runId = undefined
    state.responseRun = undefined

    // Process queued messages after abort completes
    if (state.queue.length > 0) {
      const next = state.queue.shift()!
      logger.info('[chat-run-socket][abort] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
      this.replaceState(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: runId,
        synced: true,
        queue_length: state.queue.length + 1,
      })
      this.emitToSession(socket, sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: runId,
        synced: true,
        queue_length: state.queue.length + 1,
      })
      this.emitToSession(socket, sessionId, 'run.queued', {
        event: 'run.queued',
        queue_length: state.queue.length,
      })
      state.events = []
      void this.handleRun(socket, {
        input: next.input,
        session_id: sessionId,
        model: next.model,
        provider: next.provider,
        instructions: next.instructions,
      }, next.profile || profile || 'default', true)
      return
    }

    state.events = []
    this.replaceState(sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced: true,
    })
    this.emitToSession(socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced: true,
    })
    logger.info({ sessionId, runId, synced: true }, '[chat-run-socket][abort] completed')
  }

  /**
   * Calculate usage from DB and update state + emit to clients.
   * @returns { inputTokens, outputTokens } for the caller to use
   */
  private async calcAndUpdateUsage(
    sid: string, state: SessionState, emit: (event: string, payload: any) => void,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    try {
      const detail = useLocalSessionStore()
        ? getSessionDetail(sid)
        : await getSessionDetailFromDb(sid, state.profile)
      const msgs = detail?.messages
        ?.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') || []

      const snapshot = getCompressionSnapshot(sid)
      let inputTokens: number
      let outputTokens: number
      if (snapshot && msgs.length) {
        const newMessages = msgs.slice(snapshot.lastMessageIndex + 1)
        inputTokens = countTokens(SUMMARY_PREFIX + snapshot.summary) +
          newMessages.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = newMessages
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      } else {
        inputTokens = msgs.filter(m => m.role === 'user').reduce((sum, m) => sum + countTokens(m.content || ''), 0)
        outputTokens = msgs
          .filter(m => m.role === 'assistant' || m.role === 'tool')
          .reduce((sum, m) => sum + countTokens(m.content || '') + countTokens(m.tool_calls + '' || ''), 0)
      }
      state.inputTokens = inputTokens
      state.outputTokens = outputTokens
      emit('usage.updated', {
        event: 'usage.updated',
        session_id: sid,
        inputTokens,
        outputTokens,
      })
      return { inputTokens, outputTokens }
    } catch (err: any) {
      logger.warn(err, '[chat-run-socket] failed to calculate usage for session %s', sid)
      return { inputTokens: 0, outputTokens: 0 }
    }
  }

  private async handleBrokerRun(
    socket: Socket,
    data: { input: string | ContentBlock[]; session_id?: string; model?: string; provider?: string; instructions?: string },
    profile: string,
    runMarker: string | undefined,
    emit: (event: string, payload: any) => void,
  ) {
    const { input, session_id, model, provider, instructions } = data
    const brokerUrl = config.runBrokerUrl
    if (!brokerUrl) {
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
      emit('run.failed', {
        event: 'run.failed',
        error: 'HERMES_RUN_BROKER_URL is required when HERMES_WEBUI_RUN_BROKER=1',
        queue_remaining: queueLen,
      })
      return
    }

    const userKey = (socket.data?.user?.openid as string | undefined)?.trim() || profile
    const content = contentBlocksToString(input).trim()
    const metadata: Record<string, any> = {
      source: 'hermes-web-ui',
    }
    if (model) metadata.model = model
    if (provider) metadata.provider = provider
    if (session_id) metadata.conversation = `webui:${session_id}`
    metadata.instructions = instructions
      ? `${getSystemPrompt()}\n${instructions}`
      : getSystemPrompt()

    if (session_id) {
      const sessionRow = getSession(session_id)
      if (sessionRow?.workspace) {
        const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
        metadata.instructions = metadata.instructions
          ? `\n${workspaceCtx}\n${metadata.instructions}`
          : `\n${workspaceCtx}`
      }
    }

    const builtInput = await buildResponsesInput(input, profile)
    if (builtInput !== content) {
      metadata.input = builtInput
    }

    const messages = session_id
      ? buildBrokerMessagesForSession(this.sessionMap.get(session_id)?.messages || [])
      : []

    const request = {
      channel: 'webui',
      profile_name: profile,
      user_key: userKey,
      content,
      session_id,
      delivery_mode: 'socket',
      credential_subject: userKey,
      requires_host_tools: true,
      metadata,
      messages,
    }

    const abortController = new AbortController()
    if (session_id) {
      const state = this.getOrCreateSession(session_id)
      state.isWorking = true
      state.runId = undefined
      state.abortController = abortController
      this.getResponseRunState(state, runMarker)
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
      const res = await fetch(`${brokerUrl}/api/run-broker/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: abortController.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: `Run broker ${res.status}: ${text}`, queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }
      if (!res.body) {
        const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
        if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed' })
        emit('run.failed', { event: 'run.failed', error: 'Run broker response stream missing', queue_remaining: queueLen })
        if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
        return
      }

      let runId: string | undefined
      let finalText = ''
      for await (const frame of readSseFrames(res.body)) {
        let parsed: any
        try {
          parsed = JSON.parse(frame.data)
        } catch {
          continue
        }
        const mapped = mapRunBrokerFrameForChat(parsed, frame.event)
        if (mapped.type === 'ignore') continue

        if (mapped.type === 'emit') {
          const eventRunId = mapped.payload.run_id || mapped.payload.response_id
          if (eventRunId) runId = String(eventRunId)
          if (mapped.appendFinalText) finalText += mapped.payload.delta || ''

          if (session_id) {
            const state = this.sessionMap.get(session_id)
            if (state) {
              const run = this.getResponseRunState(state, runMarker)
              run.responseId = runId || run.responseId
              const now = Math.floor(Date.now() / 1000)

              if (mapped.event === 'message.delta' && mapped.persistAssistantContent) {
                const deltaText = mapped.payload.delta || ''
                const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
                if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                  last.content += deltaText
                } else {
                  state.messages.push({
                    id: state.messages.length + 1,
                    session_id,
                    runMarker,
                    role: 'assistant',
                    content: deltaText,
                    timestamp: now,
                  })
                }
              }

              if (mapped.event === 'reasoning.delta') {
                const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
                if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
                  last.reasoning = (last.reasoning || '') + (mapped.payload.delta || '')
                } else {
                  state.messages.push({
                    id: state.messages.length + 1,
                    session_id,
                    runMarker,
                    role: 'assistant',
                    content: '',
                    reasoning: mapped.payload.delta || '',
                    timestamp: now,
                  })
                }
              }

              if (mapped.event === 'tool.started') {
                const callId = mapped.payload.tool_call_id
                if (callId) {
                  const toolCall = {
                    id: callId,
                    type: 'function',
                    function: {
                      name: mapped.payload.name || mapped.payload.tool || 'tool',
                      arguments: mapped.payload.arguments || '{}',
                    },
                  }
                  run.toolCalls.set(callId, toolCall)
                  const key = `assistant:${callId}`
                  if (!run.insertedKeys.has(key)) {
                    run.insertedKeys.add(key)
                    state.messages.push({
                      id: state.messages.length + 1,
                      session_id,
                      runMarker,
                      role: 'assistant',
                      content: '',
                      tool_calls: [toolCall],
                      finish_reason: 'tool_calls',
                      timestamp: now,
                    })
                  } else {
                    const existingAssistant = [...state.messages]
                      .reverse()
                      .find((message: any) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) => call.id === callId))
                    const existingToolCalls = Array.isArray(existingAssistant?.tool_calls) ? existingAssistant.tool_calls : null
                    if (existingAssistant && existingToolCalls) {
                      existingAssistant.tool_calls = existingToolCalls.map((call: any) => {
                        if (call.id !== callId) return call
                        const previousArgs = call.function?.arguments || '{}'
                        const nextArgs = toolCall.function.arguments || '{}'
                        return hasUsefulToolArguments(nextArgs) && !hasUsefulToolArguments(previousArgs) ? toolCall : call
                      })
                    }
                  }
                }
              }

              if (mapped.event === 'tool.completed') {
                const callId = mapped.payload.tool_call_id
                const key = callId ? `tool:${callId}` : `tool:${state.messages.length + 1}`
                const output = typeof mapped.payload.output === 'string'
                  ? mapped.payload.output
                  : JSON.stringify(mapped.payload.output ?? '')
                if (!run.insertedKeys.has(key)) {
                  run.insertedKeys.add(key)
                  const toolName = mapped.payload.name || mapped.payload.tool || run.toolCalls.get(callId)?.function?.name || null
                  state.messages.push({
                    id: state.messages.length + 1,
                    session_id,
                    runMarker,
                    role: 'tool',
                    content: output,
                    tool_call_id: callId || null,
                    tool_name: toolName,
                    timestamp: now,
                  })
                }
              }
            }
          }

          emit(mapped.event, mapped.payload)
          continue
        }

        if (mapped.type === 'terminal') {
          const eventRunId = mapped.payload.run_id || mapped.payload.response_id
          if (eventRunId) runId = String(eventRunId)
          const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
          if (session_id) await this.markCompleted(socket, session_id, { event: mapped.event, run_id: runId })
          emit(mapped.event, {
            ...mapped.payload,
            output: mapped.payload.output || finalText,
            queue_remaining: queueLen,
          })
          if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
          return
        }
      }

      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) await this.markCompleted(socket, session_id, { event: 'run.failed', run_id: runId })
      emit('run.failed', {
        event: 'run.failed',
        run_id: runId,
        response_id: runId,
        error: 'Run broker stream ended without a terminal event',
        queue_remaining: queueLen,
      })
      if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
    } catch (err: any) {
      const queueLen = session_id ? this.sessionMap.get(session_id)?.queue?.length ?? 0 : 0
      if (session_id) {
        await this.markCompleted(socket, session_id, { event: 'run.failed' })
      }
      emit('run.failed', { event: 'run.failed', error: err.message, queue_remaining: queueLen })
      if (session_id && queueLen > 0) this.dequeueNextQueuedRun(socket, session_id)
    }
  }

  private async ensureGatewayReady(profile: string): Promise<void> {
    if (typeof this.gatewayManager.detectStatus !== 'function') return
    const current = await this.gatewayManager.detectStatus(profile)
    if (current?.running) return
    if (typeof this.gatewayManager.startApiOnly === 'function') {
      await this.gatewayManager.startApiOnly(profile)
    }
  }

  private async syncFromHermes(
    _socket: Socket,
    localSessionId: string,
    hermesSessionId: string,
    profile: string,
    options: { maxAttempts?: number; delayMs?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = options.maxAttempts ?? 3
    const delayMs = options.delayMs ?? 250
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { getSessionMessagesFromDb } = await import('../../db/hermes/sessions-db')
        const detail = await getSessionMessagesFromDb(hermesSessionId, profile)
        if (detail?.messages?.length) {
          const state = this.sessionMap.get(localSessionId)
          if (state) {
            state.messages = this.handleMessage(detail.messages.map(message => ({
              ...message,
              session_id: localSessionId,
            })), localSessionId)
          }
          return true
        }
      } catch (err) {
        logger.debug(err, '[chat-run-socket] Hermes state sync attempt %d failed for %s', attempt, hermesSessionId)
      }
      if (attempt < maxAttempts) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
      }
    }
    return false
  }

  /** Get or create session state in sessionMap */
  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [], queue: [] }
      this.sessionMap.set(sessionId, state)
    }
    return state
  }

  /** Append a state event for a session (used for replay on reconnect) */
  private pushState(sessionId: string, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId)
    state.events.push({ event, data })
  }

  /** Replace the last state with the same event name, or append if different */
  private replaceState(sessionId: string, event: string, data: any) {
    const state = this.sessionMap.get(sessionId)
    if (state) {
      const idx = state.events.findIndex(s => s.event === event)
      if (idx >= 0) {
        state.events[idx] = { event, data }
        return
      }
    }
    this.pushState(sessionId, event, data)
  }

  private emitToSession(socket: Socket, sessionId: string, event: string, payload: any) {
    const tagged = { ...payload, session_id: sessionId }
    this.nsp.to(`session:${sessionId}`).emit(event, tagged)
    if (!this.nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
      socket.emit(event, tagged)
    }
  }

  /** Close all active upstream response streams */
  close() {
    for (const [sessionId, state] of this.sessionMap.entries()) {
      if (state.abortController) {
        try {
          state.abortController.abort()
        } catch (e) {
          logger.warn(e, '[chat-run-socket] failed to abort controller for session %s', sessionId)
        }
      }
    }
    this.sessionMap.clear()
    logger.info('[chat-run-socket] closed all connections and cleared state')
  }
}

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseSseFrame(raw)
        if (frame?.data) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer += decoder.decode()
    const frame = parseSseFrame(buffer)
    if (frame?.data) yield frame
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(raw: string): { event?: string; data: string } | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function responseFunctionCallToToolCall(item: any): any {
  const callId = item.call_id || item.id || ''
  const name = item.name || item.function?.name || ''
  let args = item.arguments ?? item.function?.arguments ?? '{}'
  if (typeof args !== 'string') {
    args = JSON.stringify(args ?? {})
  }
  return {
    id: callId,
    type: 'function',
    function: {
      name,
      arguments: args || '{}',
    },
  }
}

function summarizeToolArguments(args: string): string | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return args.slice(0, 120)
    const preferredKeys = ['cmd', 'command', 'code', 'query', 'path', 'url', 'prompt']
    for (const key of preferredKeys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    const first = Object.entries(parsed).find(([, value]) => typeof value === 'string' && value.trim())
    if (first) return String(first[1]).replace(/\s+/g, ' ').slice(0, 160)
    return JSON.stringify(parsed).slice(0, 160)
  } catch {
    return args.replace(/\s+/g, ' ').slice(0, 160)
  }
}

function shouldPersistToolPreviewAsArgs(args: string | undefined, preview: unknown): boolean {
  if (args && args !== '{}' && args !== '[]') return false
  if (typeof preview !== 'string') return false
  const text = preview.trim()
  if (!text || text === 'generating arguments') return false
  return true
}

function hasUsefulToolArguments(args: string): boolean {
  if (!args || args === '{}' || args === '[]') return false
  try {
    const parsed = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return false
    return Object.values(parsed).some(value => {
      if (typeof value === 'string') return Boolean(value.trim())
      return value != null
    })
  } catch {
    return Boolean(args.trim())
  }
}

function extractResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : []
  const parts: string[] = []
  for (const item of output) {
    if (item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (part.type === 'output_text' || part.type === 'text') {
        parts.push(part.text || '')
      }
    }
  }
  if (parts.length > 0) return parts.join('')
  return typeof response?.output_text === 'string' ? response.output_text : ''
}
