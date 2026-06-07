import { dirname, join } from 'path'
import { existsSync, accessSync, chmodSync, constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { createSession, addMessage, getSession, updateSession, updateSessionStats } from '../../db/hermes/session-store'
import { logger } from '../logger'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../hermes/run-chat/response-stream'
import { extractResponseText } from '../hermes/run-chat/response-utils'
import type { SessionState } from '../hermes/run-chat/types'
import type { CanonicalResponsesEvent } from './adapters/responses-stream'
import { mapCodingAgentResponseEvent } from './coding-agent-event-mapper'

const DEFAULT_IDLE_MS = 30 * 60 * 1000
const TERMINAL_OUTPUT_FLUSH_MS = 120
const MAX_TERMINAL_EVENT_CHARS = 4000

let pty: any = null

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return
  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
    const candidates = [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]
    for (const helperPath of candidates) {
      if (!existsSync(helperPath)) continue
      try {
        accessSync(helperPath, fsConstants.X_OK)
      } catch {
        chmodSync(helperPath, 0o755)
      }
    }
  } catch (err) {
    logger.warn(err, '[coding-agent-run] failed to normalize node-pty helper permissions')
  }
}

try {
  ensureNodePtySpawnHelperExecutable()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  logger.warn(err, '[coding-agent-run] node-pty unavailable; hidden coding agent sessions disabled')
}

export interface CodingAgentRunLaunch {
  agentSessionId: string
  agentId: string
  profile: string
  provider: string
  model: string
  sessionId: string
  agentNativeSessionId?: string
  nativeResume?: boolean
  command: string
  args: string[]
  shellCommand: string
  workspaceDir: string
  env?: Record<string, string>
  state?: SessionState
}

interface ManagedCodingAgentRun {
  id: string
  launch: CodingAgentRunLaunch
  pty?: { pid: number; write: (data: string) => void; kill: (signal?: string) => void; onData: (cb: (data: string) => void) => void; onExit: (cb: (event: { exitCode: number }) => void) => void }
  state: SessionState
  runMarker?: string
  lastActiveAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  terminalBuffer?: string
  terminalFlushTimer?: ReturnType<typeof setTimeout>
  apiKeyPromptAnswered?: boolean
  startedAt: number
  exited: boolean
  currentChild?: ChildProcess
  printResponseId?: string
  printMessageId?: string
  printTextStarted?: boolean
  printText?: string
  printCompleted?: boolean
  responseStartEmitted?: boolean
  terminalEventHandled?: boolean
  acceptingPrintEvent?: boolean
  printToolBlocks?: Map<number, { id: string; name: string; arguments: string; done: boolean }>
  nativeResumeReady?: boolean
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function makeId(): string {
  return `car_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isProxyToolEvent(event: CanonicalResponsesEvent): boolean {
  const data: any = event.data || {}
  const item = data.item || data.output_item || data
  return event.type === 'response.function_call_arguments.delta' ||
    ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && item?.type === 'function_call')
}

function claudeContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content == null) return ''
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (!block || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    try {
      return JSON.stringify(record)
    } catch {
      return String(record)
    }
  }).filter(Boolean).join('\n')
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL || ''
  if (shell && existsSync(shell)) return shell
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

export function sanitizeCodingAgentTerminalOutput(value: string): string {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sk-ant|sk-proj|sk-or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-api-key]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
}

export class CodingAgentRunManager {
  private runs = new Map<string, ManagedCodingAgentRun>()
  private sessionIndex = new Map<string, string>()

  constructor(private readonly idleMs = DEFAULT_IDLE_MS) {}

  isAvailable(): boolean {
    return !!pty
  }

  hasSession(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    return Boolean(run && !run.exited)
  }

  runIdForSession(sessionId: string): string | undefined {
    const run = this.getBySession(sessionId)
    return run && !run.exited ? run.id : undefined
  }

  start(launch: CodingAgentRunLaunch): { runId: string; pid: number } {
    const existingRunId = this.sessionIndex.get(launch.sessionId)
    if (existingRunId) {
      const existing = this.runs.get(existingRunId)
      if (existing && !existing.exited) return { runId: existing.id, pid: existing.pty?.pid || existing.currentChild?.pid || 0 }
    }

    const runId = launch.agentSessionId || makeId()
    const state = launch.state || { messages: [], isWorking: false, events: [], queue: [] }
    state.isWorking = true
    state.profile = launch.profile
    state.source = 'coding_agent'
    state.runId = runId

    if (launch.agentId === 'claude-code') {
      const run: ManagedCodingAgentRun = {
        id: runId,
        launch,
        state,
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        nativeResumeReady: launch.nativeResume === true,
      }
      this.runs.set(run.id, run)
      this.sessionIndex.set(launch.sessionId, run.id)
      this.ensureDbSession(run)
      this.touch(run)
      this.emitTerminalStatus(run, 'Claude Code chat runner ready.')
      logger.info({
        runId: run.id,
        sessionId: launch.sessionId,
        agentId: launch.agentId,
        profile: launch.profile,
        provider: launch.provider,
        model: launch.model,
      }, '[coding-agent-run] print runner started')
      return { runId: run.id, pid: 0 }
    }

    if (!pty) throw new Error('Hidden coding agent terminal is unavailable because node-pty is not installed')

    const shell = defaultShell()
    const args = process.platform === 'win32'
      ? ['-NoExit', '-Command', launch.shellCommand]
      : ['-lc', launch.shellCommand]
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: existsSync(launch.workspaceDir) ? launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(launch.env || {}),
      },
    })

    const run: ManagedCodingAgentRun = {
      id: runId,
      launch,
      pty: proc,
      state,
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    this.runs.set(run.id, run)
    this.sessionIndex.set(launch.sessionId, run.id)
    this.ensureDbSession(run)
    this.touch(run)
    this.emitTerminalStatus(run, `${launch.agentId === 'codex' ? 'Codex' : 'Claude Code'} session started.`)

    proc.onData((data: string) => {
      this.touch(run)
      logger.debug({ runId: run.id, bytes: Buffer.byteLength(data || '', 'utf8') }, '[coding-agent-run] pty output')
      this.maybeAnswerClaudeApiKeyPrompt(run, data)
      this.bufferTerminalOutput(run, data)
    })
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      run.exited = true
      this.cleanupRun(run, { kill: false })
      logger.info({ runId: run.id, sessionId: launch.sessionId, exitCode }, '[coding-agent-run] process exited')
    })

    logger.info({
      runId: run.id,
      sessionId: launch.sessionId,
      agentId: launch.agentId,
      profile: launch.profile,
      provider: launch.provider,
      model: launch.model,
      pid: proc.pid,
    }, '[coding-agent-run] hidden session started')

    return { runId: run.id, pid: proc.pid }
  }

  send(sessionId: string, input: string): { runId: string } {
    const run = this.getBySession(sessionId)
    if (!run) throw new Error('Coding agent session not found')
    const text = String(input || '').trim()
    if (!text) throw new Error('Input is required')
    this.ensureDbSession(run)
    this.addUserMessage(run, text)
    this.touch(run)
    this.emitTerminalStatus(run, 'Input sent to coding agent.')
    if (run.launch.agentId === 'claude-code') {
      this.startClaudePrintTurn(run, text)
      return { runId: run.id }
    }
    if (!run.pty) throw new Error('Coding agent terminal is not available')
    run.pty.write(`${text}\r`)
    return { runId: run.id }
  }

  stop(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    if (!run) return false
    this.cleanupRun(run, { kill: true })
    return true
  }

  touchByAgentSession(agentSessionId?: string | null) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (run) this.touch(run)
  }

  handleResponseEvent(agentSessionId: string | undefined, event: CanonicalResponsesEvent) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (!run) return
    if (run.launch.agentId === 'claude-code' && run.currentChild && !run.acceptingPrintEvent && !isProxyToolEvent(event)) return
    if (event.type === 'response.created') {
      if (run.responseStartEmitted) return
      run.responseStartEmitted = true
    }
    const isTerminalEvent = event.type === 'response.completed' || event.type === 'response.failed'
    if (isTerminalEvent) {
      if (run.terminalEventHandled) return
      run.terminalEventHandled = true
    }
    this.touch(run)
    this.ensureDbSession(run)
    if (!run.runMarker) run.runMarker = `coding_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    run.state.isWorking = true
    run.state.profile = run.launch.profile
    run.state.source = 'coding_agent'
    for (const mappedEvent of mapCodingAgentResponseEvent(event)) {
      this.emitToChat(run.launch.sessionId, mappedEvent.event, mappedEvent.payload)
    }
    const mapped = applyResponseStreamEvent(run.state, run.launch.sessionId, run.runMarker, event.type, event.data)
    if (mapped) this.emitToChat(run.launch.sessionId, mapped.event, mapped.payload)
    if (isTerminalEvent) {
      flushResponseRunToDb(run.state, run.launch.sessionId)
      run.state.responseRun = undefined
      run.state.isWorking = false
      updateSessionStats(run.launch.sessionId)
      const final = (event.data as any).response || event.data
      const finalText = extractResponseText(final)
      this.emitToChat(run.launch.sessionId, event.type === 'response.completed' ? 'run.completed' : 'run.failed', {
        event: event.type === 'response.completed' ? 'run.completed' : 'run.failed',
        run_id: final?.id,
        response_id: final?.id,
        output: finalText,
        usage: final?.usage,
        error: final?.error || (event.data as any).error,
      })
      this.markChatRunCompleted(run.launch.sessionId, event.type === 'response.completed' ? 'run.completed' : 'run.failed')
      run.runMarker = undefined
    }
  }

  shutdown() {
    for (const run of [...this.runs.values()]) this.cleanupRun(run, { kill: true })
  }

  private getBySession(sessionId: string): ManagedCodingAgentRun | null {
    const runId = this.sessionIndex.get(sessionId)
    return runId ? this.runs.get(runId) || null : null
  }

  private ensureDbSession(run: ManagedCodingAgentRun) {
    if (getSession(run.launch.sessionId)) return
    createSession({
      id: run.launch.sessionId,
      profile: run.launch.profile,
        source: 'coding_agent',
        agent: run.launch.agentId === 'codex' ? 'codex' : 'claude',
        agent_session_id: run.id,
        agent_native_session_id: run.launch.agentNativeSessionId,
        model: run.launch.model,
      provider: run.launch.provider,
      title: `${run.launch.agentId} ${run.launch.model}`,
      workspace: run.launch.workspaceDir,
    })
  }

  private addUserMessage(run: ManagedCodingAgentRun, content: string) {
    const timestamp = nowSeconds()
    run.state.messages.push({
      id: run.state.messages.length + 1,
      session_id: run.launch.sessionId,
      runMarker: run.runMarker,
      role: 'user',
      content,
      timestamp,
    })
    const id = addMessage({ session_id: run.launch.sessionId, role: 'user', content, timestamp })
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, messageId: id }, '[coding-agent-run] recorded user message')
  }

  private touch(run: ManagedCodingAgentRun) {
    run.lastActiveAt = Date.now()
    if (run.idleTimer) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      const current = this.runs.get(run.id)
      if (!current) return
      const remaining = this.idleMs - (Date.now() - current.lastActiveAt)
      if (remaining > 0) {
        this.touch(current)
        return
      }
      logger.info({ runId: current.id, sessionId: current.launch.sessionId, idleMs: this.idleMs }, '[coding-agent-run] closing idle hidden session')
      this.cleanupRun(current, { kill: true })
    }, this.idleMs)
  }

  private cleanupRun(run: ManagedCodingAgentRun, options: { kill: boolean }) {
    if (run.idleTimer) clearTimeout(run.idleTimer)
    this.flushTerminalOutput(run)
    if (run.terminalFlushTimer) clearTimeout(run.terminalFlushTimer)
    this.runs.delete(run.id)
    if (this.sessionIndex.get(run.launch.sessionId) === run.id) this.sessionIndex.delete(run.launch.sessionId)
    if (options.kill && !run.exited) {
      try { run.pty?.kill() } catch {}
      try { run.currentChild?.kill() } catch {}
    }
    run.exited = true
    run.state.isWorking = false
    this.emitToChat(run.launch.sessionId, 'run.failed', {
      event: 'run.failed',
      error: 'Coding agent session closed',
    })
    this.markChatRunCompleted(run.launch.sessionId, 'run.failed')
  }

  private startClaudePrintTurn(run: ManagedCodingAgentRun, input: string) {
    if (run.currentChild && !run.currentChild.killed) {
      throw new Error('Claude Code is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.printToolBlocks = new Map()

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    const nativeSessionArgs = run.launch.agentNativeSessionId
      ? (run.nativeResumeReady
          ? ['--resume', run.launch.agentNativeSessionId]
          : ['--session-id', run.launch.agentNativeSessionId])
      : []
    const args = [
      ...run.launch.args,
      ...nativeSessionArgs,
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      input,
    ]
    const child = spawn(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(run.launch.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleClaudePrintLine(run, line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = sanitizeCodingAgentTerminalOutput(chunk.toString('utf8')).trim()
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] claude print stderr')
    })

    child.on('exit', (code) => {
      if (stdoutBuffer.trim()) this.handleClaudePrintLine(run, stdoutBuffer)
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] claude print exited')
      if (code === 0) {
        this.completeClaudePrintTurn(run)
        return
      }
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: `Claude Code exited with code ${code ?? 'unknown'}` },
            output: [],
          },
        },
      })
    })
  }

  private handleClaudePrintResponseEvent(run: ManagedCodingAgentRun, event: CanonicalResponsesEvent) {
    run.acceptingPrintEvent = true
    try {
      this.handleResponseEvent(run.id, event)
    } finally {
      run.acceptingPrintEvent = false
    }
  }

  private handleClaudePrintLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json Claude print line')
      return
    }

    if (event.type === 'stream_event' && event.event) {
      this.handleClaudeAnthropicStreamEvent(run, event.event)
      return
    }

    if (typeof event.session_id === 'string' && event.session_id.trim()) {
      this.recordClaudeNativeSessionId(run, event.session_id.trim())
    }

    if ((event.type === 'assistant' || event.type === 'user') && event.message) {
      this.handleClaudeTopLevelMessage(run, event.message)
      return
    }

    if (event.type === 'result') {
      if (run.printCompleted) return
      const resultText = String(event.result || '')
      if (resultText && !run.printTextStarted) {
        this.ensureClaudePrintText(run)
        run.printText = `${run.printText || ''}${resultText}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: resultText,
          },
        })
      }
      this.completeClaudePrintTurn(run, event.usage)
    }
  }

  private recordClaudeNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    if (run.launch.agentNativeSessionId === nativeSessionId && run.nativeResumeReady) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Claude native session id')
    }
  }

  private handleClaudeTopLevelMessage(run: ManagedCodingAgentRun, message: any) {
    const role = String(message?.role || '')
    const content = Array.isArray(message?.content) ? message.content : []
    if (!content.length) return

    if (role === 'assistant') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_use') continue
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input || {}),
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }

    if (role === 'user') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_result') continue
        const callId = String(block.tool_use_id || block.id || `toolu_${index}`)
        const output = claudeContentToText(block.content)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call_output',
              id: callId,
              call_id: callId,
              output,
            },
          },
        })
      }
    }
  }

  private handleClaudeAnthropicStreamEvent(run: ManagedCodingAgentRun, event: any) {
    const type = String(event?.type || '')
    if (type === 'message_start') {
      const id = String(event?.message?.id || run.printResponseId || `resp_${Date.now()}`)
      run.printResponseId = id
      run.printMessageId = `msg_${id}`
      return
    }

    if (type === 'content_block_start') {
      const index = Number(event.index || 0)
      const block = event.content_block || {}
      if (block.type === 'text') {
        this.ensureClaudePrintText(run)
        return
      }
      if (block.type === 'tool_use') {
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: block.input ? JSON.stringify(block.input) : '',
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }

    if (type === 'content_block_delta') {
      const index = Number(event.index || 0)
      const delta = event.delta || {}
      if (delta.type === 'thinking_delta' && delta.thinking) {
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.reasoning.delta',
          data: {
            type: 'response.reasoning.delta',
            item_id: run.printMessageId,
            output_index: index,
            delta: String(delta.thinking),
          },
        })
        return
      }
      if (delta.type === 'text_delta' && delta.text) {
        this.ensureClaudePrintText(run)
        const text = String(delta.text)
        run.printText = `${run.printText || ''}${text}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        })
        return
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        let toolBlock = run.printToolBlocks?.get(index)
        if (!toolBlock) {
          toolBlock = { id: `toolu_${index}`, name: 'tool', arguments: '', done: false }
          run.printToolBlocks?.set(index, toolBlock)
        }
        const argsDelta = String(delta.partial_json)
        toolBlock.arguments += argsDelta
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            item_id: toolBlock.id,
            output_index: index,
            delta: argsDelta,
          },
        })
      }
      return
    }

    if (type === 'content_block_stop') {
      const index = Number(event.index || 0)
      const toolBlock = run.printToolBlocks?.get(index)
      if (!toolBlock || toolBlock.done) return
      toolBlock.done = true
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: index,
          item: {
            type: 'function_call',
            id: toolBlock.id,
            call_id: toolBlock.id,
            name: toolBlock.name,
            arguments: toolBlock.arguments || '{}',
          },
        },
      })
    }
  }

  private ensureClaudePrintText(run: ManagedCodingAgentRun) {
    if (run.printTextStarted) return
    run.printTextStarted = true
    const item = { type: 'message', id: run.printMessageId, status: 'in_progress', role: 'assistant', content: [] }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: { type: 'response.output_item.added', output_index: 0, item },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    })
  }

  private completeClaudePrintTurn(run: ManagedCodingAgentRun, usage?: any) {
    if (run.printCompleted) return
    run.printCompleted = true
    const text = run.printText || ''
    const output = run.printTextStarted
      ? [{
          type: 'message',
          id: run.printMessageId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        }]
      : []
    if (run.printTextStarted) {
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_text.done',
        data: {
          type: 'response.output_text.done',
          item_id: run.printMessageId,
          output_index: 0,
          content_index: 0,
          text,
        },
      })
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: output[0],
        },
      })
    }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'completed',
          model: run.launch.model,
          output,
          usage,
        },
      },
    })
  }

  private emitToChat(sessionId: string, event: string, payload: any) {
    try {
      // Lazy require avoids coupling the service to bootstrap order.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatRunServer } = require('../../routes/hermes/chat-run')
      getChatRunServer()?.emitExternalEvent?.(sessionId, event, payload)
    } catch {}
  }

  private emitTerminalStatus(run: ManagedCodingAgentRun, text: string) {
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] status')
  }

  private bufferTerminalOutput(run: ManagedCodingAgentRun, chunk: string) {
    const sanitized = sanitizeCodingAgentTerminalOutput(chunk)
    if (!sanitized.trim()) return
    run.terminalBuffer = `${run.terminalBuffer || ''}${sanitized}`
    if (run.terminalBuffer.length > MAX_TERMINAL_EVENT_CHARS * 2) {
      run.terminalBuffer = run.terminalBuffer.slice(-MAX_TERMINAL_EVENT_CHARS * 2)
    }
    if (run.terminalFlushTimer) return
    run.terminalFlushTimer = setTimeout(() => {
      run.terminalFlushTimer = undefined
      this.flushTerminalOutput(run)
    }, TERMINAL_OUTPUT_FLUSH_MS)
  }

  private maybeAnswerClaudeApiKeyPrompt(run: ManagedCodingAgentRun, chunk: string) {
    if (run.launch.agentId !== 'claude-code' || run.apiKeyPromptAnswered) return
    const text = sanitizeCodingAgentTerminalOutput(`${run.terminalBuffer || ''}${chunk}`).toLowerCase()
    if (!text.includes('detected a custom api key') && !text.includes('detectedacustomapikey')) return
    if (!text.includes('do you want to use this api key') && !text.includes('doyouwanttousethisapikey')) return
    run.apiKeyPromptAnswered = true
    this.emitTerminalStatus(run, 'Confirmed scoped Claude Code API key.')
    try {
      run.pty?.write('1\r')
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to confirm Claude Code API key prompt')
    }
  }

  private flushTerminalOutput(run: ManagedCodingAgentRun) {
    run.terminalBuffer = ''
  }

  private markChatRunCompleted(sessionId: string, event: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatRunServer } = require('../../routes/hermes/chat-run')
      getChatRunServer()?.markExternalRunCompleted?.(sessionId, event)
    } catch {}
  }
}

export const codingAgentRunManager = new CodingAgentRunManager()
