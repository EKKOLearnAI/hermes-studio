import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getRecordedUsageTotals } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { DSH_COMPACT_METHOD } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-compaction'
import { DSH_STREAM_METHOD } from '../../packages/server/src/modules/coding-agents/services/dsh/stream-plugin'

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }))

describe('DSH chat runner', () => {
  let manager: CodingAgentRunManager, workspace: string, sessionId: string, emitted: ReturnType<typeof vi.fn>
  let children: ReturnType<typeof createChild>[]
  let holdCompaction = false
  function createChild() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 999999999, exitCode: null as number | null, signalCode: null, kill: vi.fn(), sent: [] as any[],
    })
    child.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.toString())
      child.sent.push(message)
      if (!message.method || message.method === 'session/prompt' || (holdCompaction && message.method === DSH_COMPACT_METHOD)) return
      const result = message.method === 'initialize' ? { protocolVersion: 1 }
        : message.method === 'session/new' ? { sessionId: 'dsh-native' }
        : message.method === DSH_COMPACT_METHOD ? { compacted: true, beforeTokens: 900, afterTokens: 250 } : {}
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`))
    })
    child.stdin.on('finish', () => setImmediate(() => { child.exitCode = 0; child.emit('close', 0) }))
    children.push(child)
    return child
  }
  beforeEach(() => {
    initAllHermesTables()
    workspace = mkdtempSync(join(tmpdir(), 'studio-dsh-run-'))
    sessionId = `chat-${workspace}`
    children = []
    holdCompaction = false
    manager = new CodingAgentRunManager()
    emitted = vi.fn()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    ;(manager as any).emitToChat = emitted
    ;(manager as any).markChatRunCompleted = () => {}
    vi.mocked(spawn).mockImplementation(() => createChild() as any)
    manager.start({ agentSessionId: sessionId, sessionId, agentId: 'dsh', mode: 'scoped', profile: 'default', agentPreset: 'minimal',
      provider: 'test', model: 'test-model', command: 'dsh', args: ['--profile', 'acp'], shellCommand: 'dsh', workspaceDir: workspace })
  })
  afterEach(() => {
    manager.shutdown()
    for (const child of children) { child.exitCode = 0; child.emit('close', 0) }
    rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  async function prompt(text: string) {
    manager.send(sessionId, text)
    const child = children.at(-1)!
    await vi.waitFor(() => expect(child.sent.at(-1)?.method).toBe('session/prompt'))
    return child
  }
  function update(child: ReturnType<typeof createChild>, update: any) {
    child.stdout.write(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'dsh-native', update } })}\n`)
  }
  function finish(child: ReturnType<typeof createChild>) {
    child.stdout.write(`${JSON.stringify({ id: child.sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })}\n`)
  }
  it('maps ACP text, reasoning and tools and uses proxy billing without duplicate output', async () => {
    const child = await prompt('work')
    expect(child.sent.find(message => message.method === 'session/new').params._meta).toEqual({ agentPreset: 'minimal' })
    expect(getSession(sessionId)?.agent_preset).toBe('minimal')
    manager.handleResponseEvent(sessionId, { type: 'response.output_text.delta', data: { delta: 'duplicate proxy text' } })
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: { id: 'bill-1', usage: { input_tokens: 10, output_tokens: 5 } } } })
    update(child, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } })
    update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read_file', rawInput: { path: 'README.md' } })
    update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file content' } }] })
    update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'read_file', rawInput: { path: 'missing.md' } })
    update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'failed', rawOutput: 'File missing' })
    update(child, { sessionUpdate: 'usage_update', used: 900, size: 1000 })
    update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } })
    finish(child)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({ output: '完成' })))
    expect(JSON.stringify(emitted.mock.calls)).toContain('read_file')
    expect(JSON.stringify(emitted.mock.calls)).toContain('Thinking')
    expect(emitted).toHaveBeenCalledWith(sessionId, 'tool.failed', expect.objectContaining({ tool_call_id: 'tool-2' }))
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('duplicate proxy text')
    expect(getSession(sessionId)).toMatchObject({ agent: 'dsh', agent_native_session_id: 'dsh-native' })
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 10, outputTokens: 5, apiCalls: 1 })
    const next = await prompt('continue')
    expect(next.sent.some(message => message.method === 'session/resume' && message.params.sessionId === 'dsh-native')).toBe(true)
    expect(next.sent.some(message => message.method === 'session/new')).toBe(false)
    finish(next)
    await vi.waitFor(() => expect(next.exitCode).toBe(0))
  })
  it('compacts persisted history and updates context without adding an assistant message', async () => {
    const child = await prompt('work')
    finish(child)
    await vi.waitFor(() => expect(child.exitCode).toBe(0))
    emitted.mockClear()
    await expect(manager.compact(sessionId)).resolves.toMatchObject({ compacted: true, afterTokens: 250 })
    const maintenance = children.at(-1)!
    expect(maintenance.sent.map(message => message.method)).toContain(DSH_COMPACT_METHOD)
    expect(maintenance.sent.map(message => message.method)).not.toContain('session/prompt')
    expect(maintenance.sent.find(message => message.method === 'session/resume').params.sessionId).toBe('dsh-native')
    expect(emitted).toHaveBeenCalledWith(sessionId, 'usage.updated', expect.objectContaining({ contextTokens: 250 }))
    expect(emitted.mock.calls.some(([, event]) => event === 'run.completed')).toBe(false)
    await vi.waitFor(() => expect(maintenance.exitCode).toBe(0))
    const next = await prompt('continue')
    finish(next)
  })

  it('rejects argument and empty-history requests without starting a process', async () => {
    await expect(manager.compact(sessionId, 'instructions')).rejects.toThrow('does not accept arguments')
    await expect(manager.compact(sessionId)).rejects.toThrow('no native history')
    expect(children).toHaveLength(0)
  })

  it('cancels an owned compaction and rejects duplicate requests while it runs', async () => {
    const child = await prompt('work')
    finish(child)
    await vi.waitFor(() => expect(child.exitCode).toBe(0))
    holdCompaction = true
    const pending = manager.compact(sessionId)
    const rejected = expect(pending).rejects.toThrow(/disposed|closed/)
    const maintenance = children.at(-1)!
    await vi.waitFor(() => expect(maintenance.sent.at(-1)?.method).toBe(DSH_COMPACT_METHOD))
    await expect(manager.compact(sessionId)).rejects.toThrow('still processing')
    expect(manager.getRunInfo(sessionId)?.running).toBe(true)
    manager.stop(sessionId, { reportClosed: false })
    await rejected
    expect(maintenance.sent.some(message => message.method === 'session/cancel')).toBe(true)
  })

  it('reports failure when DSH exits without an ACP result', async () => {
    const child = await prompt('work')
    child.stderr.write('startup failed')
    child.exitCode = 1
    child.emit('close', 1)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.anything()))
    expect(emitted.mock.calls.filter(call => call[1] === 'run.completed')).toHaveLength(0)
  })
  it('publishes native live deltas before ACP completion without dropping repeated long text', async () => {
    const child = await prompt('work')
    const text = 'A repeated chunk longer than sixteen characters. '
    const live = (frame: object) => child.stdout.write(`${JSON.stringify({
      method: DSH_STREAM_METHOD, params: { sessionId: 'dsh-native', frame },
    })}\n`)
    for (const attemptId of ['before-tool', 'after-tool']) {
      live({ type: 'start', attemptId })
      live({ type: 'text-delta', attemptId, text })
      live({ type: 'text-delta', attemptId, text })
      // The UI event must already exist while both model and ACP are unfinished.
      expect(JSON.stringify(emitted.mock.calls)).toContain(text)
      expect(emitted.mock.calls.some(call => call[1] === 'run.completed')).toBe(false)
      live({ type: 'commit', attemptId, messageId: attemptId })
      live({ type: 'end', attemptId })
      update(child, { sessionUpdate: 'agent_message_chunk', messageId: attemptId, content: { type: 'text', text: text.repeat(2) } })
      if (attemptId === 'before-tool') {
        update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read_file', rawInput: {} })
        update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'done' })
      }
    }
    finish(child)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({ output: text.repeat(4) })))
  })
  it('cancels its ACP session and terminates its owned child on shutdown', async () => {
    const child = await prompt('work')
    manager.shutdown()
    expect(child.sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'dsh-native' } })
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGINT')
    expect(manager.getRunInfo(sessionId)).toBeNull()
  })
})
