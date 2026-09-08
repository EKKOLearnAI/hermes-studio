import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingEkkoClarification,
  cancelPendingEkkoClarifications,
  respondToEkkoClarification,
  waitForEkkoClarification,
} from '../../packages/server/src/modules/ekko/services/clarifications'
import type { AgentClarificationRequest } from '../../packages/ekko-agent/src'

afterEach(() => {
  cancelPendingEkkoClarifications()
  vi.useRealTimers()
})

function request(overrides: Partial<AgentClarificationRequest> = {}): AgentClarificationRequest {
  return {
    clarifyId: 'clarify-1',
    question: 'Pick one',
    choices: ['A', 'B'],
    timeoutMs: 300_000,
    ...overrides,
  }
}

describe('Ekko clarification broker', () => {
  it('waits for and resolves a response from the matching session', async () => {
    const onRequested = vi.fn()
    const onResolved = vi.fn()
    const result = waitForEkkoClarification(request(), {
      sessionId: 'session-1',
      onRequested,
      onResolved,
    })

    expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({
      clarifyId: 'clarify-1',
      question: 'Pick one',
    }))
    expect(respondToEkkoClarification('session-1', 'clarify-1', 'B')).toEqual({
      handled: true,
      resolved: true,
    })
    await expect(result).resolves.toBe('B')
    expect(onResolved).toHaveBeenCalledWith({
      response: 'B',
      reason: 'response',
    })
  })

  it('does not let another session resolve a pending clarification', async () => {
    const result = waitForEkkoClarification(request(), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
    })

    expect(respondToEkkoClarification('session-2', 'clarify-1', 'A')).toEqual({
      handled: true,
      resolved: false,
    })
    expect(respondToEkkoClarification('session-1', 'clarify-1', 'B')).toEqual({
      handled: true,
      resolved: true,
    })
    await expect(result).resolves.toBe('B')
  })

  it('cancels only the matching session and run generation', async () => {
    const result = waitForEkkoClarification(request(), {
      sessionId: 'session-1',
      runId: 'run-current',
      onRequested: vi.fn(),
    })

    expect(cancelPendingEkkoClarification('session-1', 'clarify-1', 'run-stale')).toEqual({
      handled: true,
      resolved: false,
    })
    expect(cancelPendingEkkoClarification('session-2', 'clarify-1', 'run-current')).toEqual({
      handled: true,
      resolved: false,
    })
    expect(cancelPendingEkkoClarification('session-1', 'clarify-1', '')).toEqual({
      handled: true,
      resolved: false,
    })
    expect(cancelPendingEkkoClarification('session-1', 'clarify-1', 'run-current')).toEqual({
      handled: true,
      resolved: true,
    })
    expect(cancelPendingEkkoClarification('session-1', 'clarify-1', 'run-current')).toEqual({
      handled: false,
      resolved: false,
    })
    await expect(result).resolves.toBe('[clarification cancelled because the run was aborted]')
    expect(respondToEkkoClarification('session-1', 'clarify-1', 'late')).toEqual({
      handled: false,
      resolved: false,
    })
  })

  it('keeps response and timeout terminal when a stop arrives later', async () => {
    const responded = waitForEkkoClarification(request(), {
      sessionId: 'session-response',
      runId: 'run-response',
      onRequested: vi.fn(),
    })
    expect(respondToEkkoClarification('session-response', 'clarify-1', 'A')).toEqual({
      handled: true,
      resolved: true,
    })
    expect(cancelPendingEkkoClarification('session-response', 'clarify-1', 'run-response')).toEqual({
      handled: false,
      resolved: false,
    })
    await expect(responded).resolves.toBe('A')

    vi.useFakeTimers()
    const timedOut = waitForEkkoClarification(request({
      clarifyId: 'clarify-timeout-before-stop',
      timeoutMs: 25,
    }), {
      sessionId: 'session-timeout',
      runId: 'run-timeout',
      onRequested: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(25)
    expect(cancelPendingEkkoClarification(
      'session-timeout',
      'clarify-timeout-before-stop',
      'run-timeout',
    )).toEqual({
      handled: false,
      resolved: false,
    })
    await expect(timedOut).resolves.toBe('[user did not respond within 5m]')
  })

  it('returns a bounded result when another clarification is already pending', async () => {
    const first = waitForEkkoClarification(request(), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
    })
    const secondRequested = vi.fn()
    const second = waitForEkkoClarification(request({ clarifyId: 'clarify-2' }), {
      sessionId: 'session-1',
      onRequested: secondRequested,
    })

    await expect(second).resolves.toBe('[another clarification is already pending for this session]')
    expect(secondRequested).not.toHaveBeenCalled()
    respondToEkkoClarification('session-1', 'clarify-1', 'A')
    await expect(first).resolves.toBe('A')
  })

  it('resolves on abort and timeout without leaving a pending request', async () => {
    const controller = new AbortController()
    const onAborted = vi.fn()
    const aborted = waitForEkkoClarification(request(), {
      sessionId: 'session-1',
      signal: controller.signal,
      onRequested: vi.fn(),
      onResolved: onAborted,
    })

    controller.abort()

    await expect(aborted).resolves.toBe('[clarification cancelled because the run was aborted]')
    expect(onAborted).toHaveBeenCalledWith(expect.objectContaining({ reason: 'aborted' }))
    expect(respondToEkkoClarification('session-1', 'clarify-1', 'late')).toEqual({
      handled: false,
      resolved: false,
    })

    vi.useFakeTimers()
    const onTimedOut = vi.fn()
    const timedOut = waitForEkkoClarification(request({
      clarifyId: 'clarify-timeout',
      timeoutMs: 25,
    }), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
      onResolved: onTimedOut,
    })
    await vi.advanceTimersByTimeAsync(25)

    await expect(timedOut).resolves.toBe('[user did not respond within 5m]')
    expect(onTimedOut).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout' }))
  })
})
