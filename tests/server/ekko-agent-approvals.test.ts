import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  denyPendingEkkoToolApprovals,
  respondToEkkoToolApproval,
  waitForEkkoToolApproval,
} from '../../packages/server/src/services/ekko-agent/approvals'
import type { AgentToolApprovalRequest } from '../../packages/ekko-agent/src'

afterEach(() => {
  denyPendingEkkoToolApprovals()
  vi.useRealTimers()
})

function request(overrides: Partial<AgentToolApprovalRequest> = {}): AgentToolApprovalRequest {
  return {
    approvalId: 'approval-1',
    toolName: 'terminal_exec',
    key: 'terminal:delete',
    command: 'rm -rf build',
    description: 'deletes files or directories',
    choices: ['once', 'session', 'always', 'deny'],
    allowPermanent: true,
    timeoutMs: 300_000,
    ...overrides,
  }
}

describe('Ekko tool approval broker', () => {
  it('waits for and resolves a response from the matching session', async () => {
    const onRequested = vi.fn()
    const onResolved = vi.fn()
    const result = waitForEkkoToolApproval(request(), {
      sessionId: 'session-1',
      onRequested,
      onResolved,
    })

    expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: 'approval-1',
      key: 'terminal:delete',
    }))
    expect(respondToEkkoToolApproval('session-1', 'approval-1', 'session')).toEqual({
      handled: true,
      resolved: true,
      choice: 'session',
    })
    await expect(result).resolves.toBe('session')
    expect(onResolved).toHaveBeenCalledWith('session')
  })

  it('does not let another session resolve a pending approval', async () => {
    const result = waitForEkkoToolApproval(request(), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
    })

    expect(respondToEkkoToolApproval('session-2', 'approval-1', 'always')).toEqual({
      handled: true,
      resolved: false,
      choice: 'always',
    })
    expect(respondToEkkoToolApproval('session-1', 'approval-1', 'once')).toMatchObject({
      handled: true,
      resolved: true,
    })
    await expect(result).resolves.toBe('once')
  })

  it('fails a concurrent request closed when the session already has a visible approval', async () => {
    const first = waitForEkkoToolApproval(request(), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
    })
    const secondRequested = vi.fn()
    const second = waitForEkkoToolApproval(request({ approvalId: 'approval-2' }), {
      sessionId: 'session-1',
      onRequested: secondRequested,
    })

    await expect(second).resolves.toBe('deny')
    expect(secondRequested).not.toHaveBeenCalled()
    respondToEkkoToolApproval('session-1', 'approval-1', 'once')
    await expect(first).resolves.toBe('once')
  })

  it('denies a pending approval when the run is aborted', async () => {
    const controller = new AbortController()
    const onResolved = vi.fn()
    const result = waitForEkkoToolApproval(request(), {
      sessionId: 'session-1',
      signal: controller.signal,
      onRequested: vi.fn(),
      onResolved,
    })

    controller.abort()

    await expect(result).resolves.toBe('deny')
    expect(onResolved).toHaveBeenCalledWith('deny')
    expect(respondToEkkoToolApproval('session-1', 'approval-1', 'once')).toMatchObject({
      handled: false,
    })
  })

  it('denies on timeout and normalizes unsupported responses to deny', async () => {
    vi.useFakeTimers()
    const onResolved = vi.fn()
    const result = waitForEkkoToolApproval(request({ timeoutMs: 25 }), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
      onResolved,
    })

    await vi.advanceTimersByTimeAsync(25)

    await expect(result).resolves.toBe('deny')
    expect(onResolved).toHaveBeenCalledWith('deny')

    const second = waitForEkkoToolApproval(request({ approvalId: 'approval-2' }), {
      sessionId: 'session-1',
      onRequested: vi.fn(),
    })
    respondToEkkoToolApproval('session-1', 'approval-2', 'unsupported')
    await expect(second).resolves.toBe('deny')
  })
})
