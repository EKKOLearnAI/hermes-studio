import { beforeEach, describe, expect, it, vi } from 'vitest'

const runAndWaitMock = vi.hoisted(() => vi.fn())
const ioMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: vi.fn(() => ({ runAndWait: runAndWaitMock })),
}))

vi.mock('socket.io-client', () => ({ io: ioMock }))

function makeCtx(body: Record<string, unknown>) {
  return {
    state: { profile: { name: 'default' }, user: { id: 1, role: 'super_admin' } },
    request: { body },
    status: 200,
    body: undefined as any,
  }
}

describe('chat-run HTTP API controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runAndWaitMock.mockImplementation(async (data: any, options: any) => {
      options.onEvent?.('run.started', { event: 'run.started', run_id: 'run-1' })
      options.onEvent?.('message.delta', { event: 'message.delta', run_id: 'run-1', delta: 'hello' })
      options.onEvent?.('run.completed', { event: 'run.completed', run_id: 'run-1', output: 'hello' })
      return {
        ok: true,
        event: 'run.completed',
        session_id: data.session_id,
        run_id: 'run-1',
        output: 'hello',
      }
    })
  })

  it('runs chat-run through the in-process server and returns a completed HTTP response', async () => {
    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ session_id: 'session-1', input: 'hello', include_events: true })

    await runOnce(ctx as any)

    expect(ioMock).not.toHaveBeenCalled()
    expect(runAndWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', input: 'hello', profile: 'default' }),
      expect.objectContaining({ profile: 'default', user: ctx.state.user, detachOnAction: true }),
    )
    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      status: 'completed',
      session_id: 'session-1',
      run_id: 'run-1',
      output: 'hello',
    })
    expect(ctx.body.events).toHaveLength(3)
  })

  it('generates a session id when none is provided', async () => {
    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ source: 'cli', input: 'start a new chat' })

    await runOnce(ctx as any)

    const payload = runAndWaitMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.session_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(payload).toMatchObject({ source: 'cli', input: 'start a new chat', profile: 'default' })
    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ ok: true, status: 'completed', session_id: payload.session_id })
  })

  it('generates a session id for global-agent runs when none is provided', async () => {
    const { runOnce } = await import('../../packages/server/src/controllers/chat-run')
    const ctx = makeCtx({ source: 'global_agent', input: 'start a global run' })

    await runOnce(ctx as any)

    const payload = runAndWaitMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.session_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(payload).toMatchObject({ source: 'global_agent', input: 'start a global run', profile: 'default' })
    expect(ctx.body).toMatchObject({ ok: true, status: 'completed', session_id: payload.session_id })
  })
})
