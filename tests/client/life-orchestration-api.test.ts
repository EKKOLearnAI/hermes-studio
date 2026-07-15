import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))
import * as api from '@/api/hermes/life-orchestration'

describe('life orchestration client API', () => {
  beforeEach(() => request.mockReset())

  it('loads minimized resources with encoded bounded queries', async () => {
    request.mockResolvedValueOnce({ summary: {} }).mockResolvedValueOnce({ commitments: [{ id: 'commitment-1' }] })
      .mockResolvedValueOnce({ subscriptions: [{ id: 'subscription-1' }] })
    await api.fetchLifeOverview()
    await expect(api.fetchLifeCommitments('account / one')).resolves.toEqual([{ id: 'commitment-1' }])
    await expect(api.fetchLifeSubscriptions('account / one')).resolves.toEqual([{ id: 'subscription-1' }])
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/life/overview')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/life/commitments?accountId=account+%2F+one&limit=100')
    expect(request).toHaveBeenNthCalledWith(3, '/api/hermes/life/subscriptions?accountId=account+%2F+one&limit=100')
  })

  it('submits semantic exact hold and cancellation DTOs without server-owned material', async () => {
    request.mockResolvedValue({ workflow: { id: 'workflow-1' } })
    const common = { idempotencyKey: 'request-123', rationale: 'Exact action' }
    await api.createLifeHold({ accountId: 'calendar-1', planRevisionId: 'plan-1', optionId: 'option-1',
      providerRequestId: 'hold-request-1', ...common })
    await api.cancelLifeSubscription({ subscriptionId: 'subscription-1', providerRequestId: 'cancel-request-1',
      reasonCode: 'NO_LONGER_NEEDED', ...common })
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/life/holds', { method: 'POST', body: JSON.stringify({
      accountId: 'calendar-1', planRevisionId: 'plan-1', optionId: 'option-1',
      providerRequestId: 'hold-request-1', ...common }) })
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/life/subscriptions/cancel', { method: 'POST',
      body: JSON.stringify({ subscriptionId: 'subscription-1', providerRequestId: 'cancel-request-1',
        reasonCode: 'NO_LONGER_NEEDED', ...common }) })
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/providerHoldId|providerSubscriptionId|planDigest|subscriptionDigest|cookie|credential|rawPayload/i)
  })

  it('uses explicit authority and workflow review routes', async () => {
    request.mockResolvedValueOnce({ source: { id: 'source-1' }, review: { id: 'review-1' } })
      .mockResolvedValueOnce({ workflow: { id: 'workflow / 1' } })
    await api.activateLifeSource('source / 1', 'live', { currency: 'CNY', calendarIds: ['source / 1'], subscriptionIds: [] })
    await expect(api.reviewLifeWorkflow('workflow / 1', 'reject', 'USER_REJECTED')).resolves.toEqual({ id: 'workflow / 1' })
    expect(request.mock.calls[0]![0]).toBe('/api/hermes/life/sources/source%20%2F%201/activate')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/action-fabric/workflows/workflow%20%2F%201/reject',
      { method: 'POST', body: JSON.stringify({ reason: 'USER_REJECTED' }) })
  })

  it('does not expose raw provider, contact-channel, browser, or device control calls', () => {
    expect(Object.keys(api).filter(name => /generic|raw|url|cookie|browser|android|credential|contactChannel|providerPayload/i.test(name))).toEqual([])
  })
})
