import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAndWaitMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: vi.fn(() => ({ runAndWait: runAndWaitMock })),
}))

function makeCtx(body: Record<string, unknown>) {
  return {
    state: { profile: { name: 'default' }, user: { id: 1, role: 'super_admin' } },
    request: { body },
    status: 200,
    body: undefined as any,
  }
}

describe('chat-run action/event baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns requires_action without exposing the internal invocation id', async () => {
    runAndWaitMock.mockImplementation(async (_data: any, options: any) => {
      options.onEvent?.('run.started', { run_id: 'run-1' })
      options.onEvent?.('approval.requested', { run_id: 'run-1', approval_id: 'approval-1', command: 'touch file' })
      return {
        ok: false,
        event: 'action.required',
        session_id: 'session-1',
        run_id: 'run-1',
        action: { event: 'approval.requested', run_id: 'run-1', approval_id: 'approval-1', command: 'touch file' },
      }
    })

    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'needs approval', include_events: true })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toMatchObject({
      ok: false,
      status: 'requires_action',
      event: 'approval.requested',
      session_id: 'session-1',
      run_id: 'run-1',
      action: { approval_id: 'approval-1' },
    })
    expect(ctx.body).not.toHaveProperty('invocation_id')
    expect(runAndWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', input: 'needs approval' }),
      expect.objectContaining({ profile: 'default', attachmentTimeoutMs: 300000, detachOnAction: true }),
    )
  })

  it('strips caller-provided invocation ids from the internal run payload and response', async () => {
    runAndWaitMock.mockResolvedValue({
      ok: true,
      event: 'run.completed',
      session_id: 'session-1',
      run_id: 'run-1',
      output: 'done',
      invocation_id: 'internal-secret',
    })
    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({
      session_id: 'session-1', input: 'hello', invocation_id: 'caller-controlled', include_events: true,
    })

    await runOnce(ctx as any)

    expect(runAndWaitMock.mock.calls[0][0]).not.toHaveProperty('invocation_id')
    expect(ctx.body).not.toHaveProperty('invocation_id')
  })

  it('returns requires_action when clarification is requested', async () => {
    runAndWaitMock.mockResolvedValue({
      ok: false,
      event: 'action.required',
      session_id: 'session-1',
      run_id: 'run-1',
      action: { event: 'clarify.requested', run_id: 'run-1', question: 'Which room?' },
    })

    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'needs clarify', include_events: true })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toMatchObject({
      ok: false,
      status: 'requires_action',
      event: 'clarify.requested',
      action: { question: 'Which room?' },
    })
  })

  it('records bounded event history and returns the authoritative result', async () => {
    runAndWaitMock.mockImplementation(async (_data: any, options: any) => {
      options.onEvent?.('run.started', { run_id: 'run-1' })
      options.onEvent?.('reasoning.delta', { run_id: 'run-1', delta: 'thought' })
      options.onEvent?.('tool.started', { run_id: 'run-1', name: 'lookup' })
      options.onEvent?.('tool.completed', { run_id: 'run-1', name: 'lookup' })
      options.onEvent?.('message.delta', { run_id: 'run-1', delta: 'hello' })
      options.onEvent?.('run.completed', { run_id: 'run-1', output: 'hello', reasoning: 'thought' })
      return { ok: true, event: 'run.completed', session_id: 'session-1', run_id: 'run-1', output: 'hello', reasoning: 'thought' }
    })

    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'hello', include_events: true, timeout_ms: 3600000 })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      output: 'hello',
      reasoning: 'thought',
      run_id: 'run-1',
    })
    expect(ctx.body.events.map((event: any) => event.event)).toEqual([
      'run.started',
      'reasoning.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'run.completed',
    ])
    expect(runAndWaitMock.mock.calls[0][1].attachmentTimeoutMs).toBe(1800000)
  })

  it('maps attachment expiry to HTTP 504 without exposing internal state', async () => {
    runAndWaitMock.mockResolvedValue({
      ok: false,
      event: 'wait.timed_out',
      session_id: 'session-1',
      error: 'chat-run attachment timed out after 25ms',
    })
    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'slow', timeout_ms: 25 })
    await runOnce(ctx as any)

    expect(ctx.status).toBe(504)
    expect(ctx.body).toMatchObject({ ok: false, status: 'timeout', session_id: 'session-1' })
    expect(ctx.body).not.toHaveProperty('invocation_id')
  })
})
