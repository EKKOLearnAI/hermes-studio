import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatRunSocket } from '../../packages/server/src/services/hermes/chat-run-socket'

function makeChatRunSocket() {
  const emit = vi.fn()
  const nsp = {
    use: vi.fn(),
    on: vi.fn(),
    to: vi.fn(() => ({ emit })),
    emit,
    adapter: { rooms: new Map() },
  }
  const io = { of: vi.fn(() => nsp) }
  const gatewayManager = {
    getUpstream: vi.fn(() => 'http://127.0.0.1:9999'),
    getApiKey: vi.fn(() => 'test-key'),
  }
  return new ChatRunSocket(io as any, gatewayManager)
}

describe('ChatRunSocket approval event normalization', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes upstream approval_required status into canonical approval.request for clients', () => {
    const service = makeChatRunSocket() as any

    const event = service.normalizeApprovalRequest({
      event: 'tool.completed',
      status: 'approval_required',
      command: 'rm -rf /tmp/example',
      description: 'dangerous command',
      pattern_key: 'rm_rf',
    }, 'run-123')

    expect(event).toMatchObject({
      event: 'approval.request',
      run_id: 'run-123',
      command: 'rm -rf /tmp/example',
      description: 'dangerous command',
      pattern_key: 'rm_rf',
      choices: ['once', 'session', 'always', 'deny'],
    })
  })

  it('passes through upstream approval.request choices and pattern_keys', () => {
    const service = makeChatRunSocket() as any

    const event = service.normalizeApprovalRequest({
      event: 'approval.request',
      run_id: 'run-456',
      command: 'git reset --hard HEAD',
      pattern_keys: ['git_reset_hard'],
      choices: ['once', 'session', 'always', 'deny'],
    }, 'ignored')

    expect(event).toMatchObject({
      event: 'approval.request',
      run_id: 'run-456',
      pattern_keys: ['git_reset_hard'],
      choices: ['once', 'session', 'always', 'deny'],
    })
  })

  it('posts approval responses to the upstream run-scoped approval endpoint after capability check', async () => {
    const service = makeChatRunSocket() as any
    service.sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      events: [],
      runId: 'run-123',
      profile: 'default',
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          features: { approval_events: true, run_approval_response: true },
          endpoints: { run_approval: { method: 'POST', path: '/v1/runs/{run_id}/approval' } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ resolved: 1, choice: 'session' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await service.handleApprovalRespond({ connected: true, emit: vi.fn() }, 'session-1', 'session', false)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9999/v1/capabilities')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:9999/v1/runs/run-123/approval')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ choice: 'session', all: false })
  })

  it('ignores ordinary upstream events', () => {
    const service = makeChatRunSocket() as any

    expect(service.normalizeApprovalRequest({ event: 'tool.completed', status: 'done' }, 'run-123')).toBeNull()
  })
})
