import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/internet-execution'

describe('internet execution client API', () => {
  beforeEach(() => request.mockReset().mockResolvedValue({ receipts: [], workflow: {}, receipt: {}, evidence: [] }))

  it('uses bounded collection filters and encodes workflow identities', async () => {
    await api.fetchInternetOverview()
    await api.fetchInternetReceipts({ status: 'verified', limit: 25 })
    await api.fetchInternetReceipt('workflow / one')
    await api.fetchInternetWorkflow('workflow / one')
    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/internet-execution/overview',
      '/api/hermes/internet-execution/receipts?status=verified&limit=25',
      '/api/hermes/internet-execution/receipts/workflow%20%2F%20one',
      '/api/hermes/internet-execution/workflows/workflow%20%2F%20one',
    ])
  })

  it('submits only semantic Bilibili search and inspect inputs', async () => {
    request.mockResolvedValue({ workflow: { id: 'workflow:one' } })
    await api.searchBilibiliVideos({ query: 'Hermes Agent', limit: 8, page: 2, order: 'newest', idempotencyKey: 'search-1' })
    await api.inspectBilibiliVideo({ bvid: 'BV1ab2cd3EF4', idempotencyKey: 'inspect-1' })

    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/internet-execution/bilibili/search',
      '/api/hermes/internet-execution/bilibili/inspect',
    ])
    const bodies = request.mock.calls.map(call => JSON.parse(call[1].body))
    expect(bodies).toEqual([
      { query: 'Hermes Agent', limit: 8, page: 2, order: 'newest', idempotencyKey: 'search-1' },
      { bvid: 'BV1ab2cd3EF4', idempotencyKey: 'inspect-1' },
    ])
    expect(JSON.stringify(bodies)).not.toMatch(/credential|token|serverId|toolName|browserSession|targetUrl/i)
  })
})
