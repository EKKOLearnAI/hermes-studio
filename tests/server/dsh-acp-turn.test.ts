import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'

const turns: DshAcpTurn[] = []
afterEach(() => { for (const turn of turns.splice(0)) turn.dispose(); vi.useRealTimers() })

function connection(options: { resumeError?: boolean; permissionRequired?: boolean; holdPrompt?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
  const sent: any[] = []
  const update = vi.fn(), session = vi.fn(), config = vi.fn()
  const receive = (value: object) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString())
    sent.push(message)
    if (!message.method || message.id === undefined) return
    const result = message.method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } }
      : message.method === 'session/new' ? { sessionId: 'native-1', configOptions: [] }
      : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
    if (options.holdPrompt && message.method === 'session/prompt') return
    queueMicrotask(() => receive({ id: message.id, ...(message.method === 'session/resume' && options.resumeError
      ? { error: { code: -32000, message: 'Session missing' } } : { result }) }))
  })
  const turn = new DshAcpTurn(child as unknown as ChildProcess, { update, session, config, permissionRequired: options.permissionRequired })
  turns.push(turn)
  return { child, turn, sent, receive, update, session }
}

describe('DSH ACP connection', () => {
  it('negotiates, creates, selects the opaque model value, prompts and closes before EOF', async () => {
    const { turn, sent, child, session } = connection()
    await expect(turn.prompt({ cwd: '/workspace', text: '--hello', images: [], modelValue: '["ekko-studio","custom"]' })).resolves.toBe('end_turn')
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/close'])
    expect(sent[2].params).toEqual({ sessionId: 'native-1', configId: 'model', value: '["ekko-studio","custom"]' })
    expect(sent[3].params.prompt).toEqual([{ type: 'text', text: '--hello' }])
    expect(session).toHaveBeenCalledWith('native-1')
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('never creates an empty replacement when native resume fails', async () => {
    const { turn, sent, session } = connection({ resumeError: true })
    await expect(turn.prompt({ cwd: '/workspace', nativeSessionId: 'missing', text: 'continue', images: [] })).rejects.toThrow('Session missing')
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/resume'])
    expect(session).not.toHaveBeenCalled()
  })

  it('rejects unsupported images before committing a session', async () => {
    const { turn, sent } = connection()
    await expect(turn.prompt({ cwd: '/workspace', text: '', images: [{ path: '/missing.png' }] })).rejects.toThrow('does not support image')
    expect(sent).toHaveLength(1)
  })

  it.each([false, true])('handles permission choices and fragmented UTF-8 updates (approval required: %s)', async permissionRequired => {
    const { turn, sent, child, receive, update } = connection({ permissionRequired, holdPrompt: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    const rejected = expect(pending).rejects.toThrow('cancelled by test')
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    const notification = Buffer.from(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } } })}\n`)
    for (const byte of notification) child.stdout.write(Buffer.from([byte]))
    receive({ method: 'session/update', params: { sessionId: 'someone-else', update: { sessionUpdate: 'agent_message_chunk' } } })
    expect(update).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
    receive({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native-1', options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } })
    expect(sent.at(-1).result.outcome).toEqual({ outcome: 'selected', optionId: permissionRequired ? 'no' : 'yes' })
    turn.cancel()
    expect(sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'native-1' } })
    turn.dispose(new Error('cancelled by test'))
    await rejected
  })

  it('fails pending work when the process closes without a prompt result', async () => {
    const { turn, child, sent } = connection({ holdPrompt: true })
    const pending = expect(turn.prompt({ cwd: '/workspace', text: 'go', images: [] })).rejects.toThrow('connection closed')
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    child.emit('close', 0)
    await pending
  })

  it('bounds a stalled initialize request', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
    const turn = new DshAcpTurn(child as unknown as ChildProcess, { update: () => {}, session: () => {}, config: () => {} })
    turns.push(turn)
    const pending = expect(turn.prompt({ cwd: '/workspace', text: 'go', images: [] })).rejects.toThrow('initialize timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
  })
})
