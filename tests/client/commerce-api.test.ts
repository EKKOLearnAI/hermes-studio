import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))
import * as api from '@/api/hermes/commerce'

describe('commerce client API', () => {
  beforeEach(() => request.mockReset())

  it('loads minimized dashboard resources with encoded bounded queries', async () => {
    request.mockResolvedValueOnce({ summary: {} }).mockResolvedValueOnce({ offers: [{ id: 'offer-1' }] })
      .mockResolvedValueOnce({ transactions: [{ id: 'transaction-1' }] })
    await api.fetchCommerceOverview()
    await expect(api.fetchCommerceOffers('account / one')).resolves.toEqual([{ id: 'offer-1' }])
    await expect(api.fetchCommerceTransactions('account / one')).resolves.toEqual([{ id: 'transaction-1' }])
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/commerce/overview')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/commerce/offers?accountId=account+%2F+one&limit=100')
    expect(request).toHaveBeenNthCalledWith(3, '/api/hermes/commerce/transactions?accountId=account+%2F+one&limit=100')
  })

  it('submits semantic order and payment DTOs without raw provider primitives', async () => {
    request.mockResolvedValue({ workflow: { id: 'workflow-1' } })
    const common = { idempotencyKey: 'request-123', rationale: 'Exact action' }
    await api.placeCommerceOrder({ quoteId: 'quote-1', providerRequestId: 'provider-request-1', ...common })
    await api.confirmCommercePayment({ transactionId: 'transaction-1', approvalId: 'approval-1', ...common })
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/commerce/orders', { method: 'POST',
      body: JSON.stringify({ quoteId: 'quote-1', providerRequestId: 'provider-request-1', ...common }) })
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/commerce/payments', { method: 'POST',
      body: JSON.stringify({ transactionId: 'transaction-1', approvalId: 'approval-1', ...common }) })
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/cookie|selector|coordinate|script|paymentCredential|address/i)
  })

  it('uses explicit authority and workflow review routes', async () => {
    request.mockResolvedValueOnce({ account: { id: 'account-1' }, review: { id: 'review-1' } })
      .mockResolvedValueOnce({ workflow: { id: 'workflow / 1' } })
    await api.activateCommerceAccount('account / 1', 'live', { currency: 'CNY', perActionMinor: 100,
      dailyMinor: 200, merchantIds: ['merchant-1'], destinationDigests: ['a'.repeat(64)] })
    await expect(api.reviewCommerceWorkflow('workflow / 1', 'reject', 'USER_REJECTED'))
      .resolves.toEqual({ id: 'workflow / 1' })
    expect(request.mock.calls[0]![0]).toBe('/api/hermes/commerce/accounts/account%20%2F%201/activate')
    expect(request).toHaveBeenNthCalledWith(2,
      '/api/hermes/action-fabric/workflows/workflow%20%2F%201/reject',
      { method: 'POST', body: JSON.stringify({ reason: 'USER_REJECTED' }) })
  })

  it('does not expose generic checkout, raw provider, browser, or Android control calls', () => {
    expect(Object.keys(api).filter(name => /generic|raw|url|cookie|browser|android|credential|selector|coordinate/i.test(name)))
      .toEqual([])
  })
})
