import type { Context } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectLocalAgentHandoff,
  resetLocalHandoffJobsForTest,
} from '../../packages/server/src/controllers/hermes/group-chat-agent-link'
import { GROUP_AGENT_PAIRING_REQUEST_TTL_MS } from '../../packages/server/src/services/hermes/group-chat/agent-relay-store'
import { setGroupChatRuntimeServer } from '../../packages/server/src/services/hermes/group-chat/runtime'

vi.mock('../../packages/server/src/services/hermes/group-chat/agent-relay', () => ({
  getGroupAgentOutboundRelayManager: vi.fn(() => ({ connect: vi.fn() })),
  GROUP_AGENT_RELAY_PROTOCOL_VERSION: 2,
}))

function handoffBody(index = 1): Record<string, unknown> {
  return {
    cloudOrigin: 'https://cloud.example',
    targetOrigin: 'http://127.0.0.1:3000',
    inviteCode: 'ROOMCODE',
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    requestSecret: 'r'.repeat(32),
    pairingTicket: 'p'.repeat(32),
    agent: {
      agent: 'hermes',
      profile: 'default',
      name: 'Worker',
    },
  }
}

function handoffContext(body = handoffBody(), userId = 1): Context {
  return {
    request: { body },
    state: { user: { id: userId, role: 'user', profiles: [] } },
    ip: '127.0.0.1',
    set: vi.fn(),
  } as unknown as Context
}

describe('group chat Agent handoff security limits', () => {
  beforeEach(() => {
    setGroupChatRuntimeServer({
      getChatRunService: () => null,
    } as any)
  })

  afterEach(() => {
    resetLocalHandoffJobsForTest()
    setGroupChatRuntimeServer(null)
    vi.unstubAllGlobals()
  })

  it('cancels a chunked cloud response as soon as it exceeds the byte limit', async () => {
    const cancel = vi.fn()
    let chunksSent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1
        controller.enqueue(new Uint8Array(128_000))
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
    const ctx = handoffContext()

    await connectLocalAgentHandoff(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({ error: 'Remote group chat response is too large' })
    expect(chunksSent).toBeGreaterThanOrEqual(3)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a cloud expiry beyond the local handoff lifetime', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      request: {
        expiresAt: Date.now() + GROUP_AGENT_PAIRING_REQUEST_TTL_MS + 60_000,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = handoffContext()

    await connectLocalAgentHandoff(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({
      error: 'Pairing request expiry exceeds the allowed handoff lifetime',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('allows handoff requests to a remote HTTP group chat server', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/submit')) {
        return Promise.resolve(new Response(JSON.stringify({
          request: { expiresAt: Date.now() + GROUP_AGENT_PAIRING_REQUEST_TTL_MS },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return new Promise<Response>(() => undefined)
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = handoffContext({
      ...handoffBody(),
      cloudOrigin: 'http://47.243.215.84:8088',
    })

    await connectLocalAgentHandoff(ctx)

    expect(ctx.status).toBe(202)
    expect(ctx.body).toEqual({ ok: true, accepted: true })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/47\.243\.215\.84:8088\/api\/hermes\/group-chat\/invites\/ROOMCODE\/agent-links\//),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('limits concurrent handoffs for one authenticated local user', async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/submit')) {
        return Promise.resolve(new Response(JSON.stringify({
          request: { expiresAt: Date.now() + GROUP_AGENT_PAIRING_REQUEST_TTL_MS },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      return new Promise<Response>(() => undefined)
    })
    vi.stubGlobal('fetch', fetchMock)

    for (let index = 1; index <= 4; index += 1) {
      const ctx = handoffContext(handoffBody(index))
      await connectLocalAgentHandoff(ctx)
      expect(ctx.status).toBe(202)
    }

    const limited = handoffContext(handoffBody(5))
    await connectLocalAgentHandoff(limited)

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({
      code: 'GROUP_AGENT_HANDOFF_LIMIT',
      error: 'Too many Agent handoff requests are already in progress',
    })
    expect(limited.set).toHaveBeenCalledWith('Retry-After', '5')
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })
})
