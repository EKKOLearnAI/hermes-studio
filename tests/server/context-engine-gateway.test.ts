import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())
const destroyMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: class {
    request(payload: unknown, options: unknown) {
      return requestMock(payload, options)
    }

    destroy(...args: unknown[]) {
      return destroyMock(...args)
    }
  },
}))

import { GatewaySummarizer } from '../../packages/server/src/services/hermes/context-engine/gateway-client'
import type { StoredMessage } from '../../packages/server/src/services/hermes/context-engine/types'

const message: StoredMessage = {
  id: 'message-1',
  roomId: 'private-room',
  senderId: 'user-1',
  senderName: 'Alice',
  content: 'private context',
  timestamp: 1,
}

const registeredSessionId = `gc_h_${'a'.repeat(32)}`

describe('GatewaySummarizer registered sessions', () => {
  beforeEach(() => {
    requestMock.mockReset()
    destroyMock.mockReset()
  })

  it('registers before Bridge use and releases the durable lease afterward', async () => {
    const order: string[] = []
    const release = vi.fn(() => order.push('release'))
    const registrar = vi.fn(() => {
      order.push('register')
      return { sessionId: registeredSessionId, authorizationGuard: () => true, release }
    })
    requestMock.mockImplementation(async () => {
      order.push('request')
      return { status: 'complete', result: { final_response: 'summary' } }
    })

    const result = await new GatewaySummarizer().summarize(
      '',
      null,
      'system prompt',
      [message],
      'private-room',
      'default',
      undefined,
      registrar,
    )

    expect(result).toEqual({ summary: 'summary', sessionId: registeredSessionId })
    expect(order).toEqual(['register', 'request', 'release'])
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: registeredSessionId }),
      expect.anything(),
    )
    expect(release).toHaveBeenCalledOnce()
    expect(destroyMock).not.toHaveBeenCalled()
  })

  it('aborts after the Bridge await when the registered lease is revoked', async () => {
    let authorized = true
    const release = vi.fn()
    requestMock.mockImplementation(async () => {
      authorized = false
      return { status: 'complete', result: { final_response: 'must not be accepted' } }
    })

    await expect(new GatewaySummarizer().summarize(
      '',
      null,
      'system prompt',
      [message],
      'private-room',
      'default',
      undefined,
      () => ({
        sessionId: registeredSessionId,
        authorizationGuard: () => authorized,
        release,
      }),
    )).rejects.toThrow('summary session authorization changed')

    expect(requestMock).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('has no Bridge side effect when registration fails', async () => {
    const registrar = vi.fn(() => {
      throw new Error('registration denied')
    })

    await expect(new GatewaySummarizer().summarize(
      '',
      null,
      'system prompt',
      [message],
      'private-room',
      'default',
      undefined,
      registrar,
    )).rejects.toThrow('registration denied')

    expect(requestMock).not.toHaveBeenCalled()
    expect(destroyMock).not.toHaveBeenCalled()
  })

  it('releases the durable lease when the Bridge request fails', async () => {
    const release = vi.fn()
    requestMock.mockRejectedValue(new Error('bridge failed'))

    await expect(new GatewaySummarizer().summarize(
      '',
      null,
      'system prompt',
      [message],
      'private-room',
      'default',
      undefined,
      () => ({ sessionId: registeredSessionId, authorizationGuard: () => true, release }),
    )).rejects.toThrow('bridge failed')

    expect(release).toHaveBeenCalledOnce()
    expect(destroyMock).not.toHaveBeenCalled()
  })
})
