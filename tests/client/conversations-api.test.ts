import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  request: mockRequest,
}))

import { fetchConversationDetail, fetchConversationSummaries } from '@/api/hermes/conversations'

describe('conversations api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds summaries URLs with optional params', async () => {
    mockRequest.mockResolvedValue({ sessions: [] })

    await fetchConversationSummaries()
    await fetchConversationSummaries({ humanOnly: false, source: 'cli', limit: 25 })

    expect(mockRequest).toHaveBeenNthCalledWith(1, '/api/hermes/sessions/conversations')
    expect(mockRequest).toHaveBeenNthCalledWith(2, '/api/hermes/sessions/conversations?humanOnly=false&source=cli&limit=25')
  })

  it('encodes detail URLs and forwards optional params', async () => {
    mockRequest.mockResolvedValue({ session_id: 'conv', messages: [], visible_count: 0, thread_session_count: 1 })

    await fetchConversationDetail('folder/with spaces', { humanOnly: false, source: 'discord' })

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/sessions/conversations/folder%2Fwith%20spaces/messages?humanOnly=false&source=discord')
  })

  it('propagates conversation detail errors so the monitor can render an error state', async () => {
    mockRequest.mockRejectedValue(new Error('boom'))

    await expect(fetchConversationDetail('conv-1', { humanOnly: true })).rejects.toThrow('boom')
  })
})
