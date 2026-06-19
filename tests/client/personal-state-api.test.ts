// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  approvePersonalStateProposal,
  checkInPersonalStateTask,
  fetchPersonalStateOverview,
  rejectPersonalStateProposal,
} from '../../packages/client/src/api/hermes/personal-state'

describe('Personal State API', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  it('fetches overview with optional profile and query params', async () => {
    mockRequest.mockResolvedValue({ overview: { profile: 'default' } })

    await expect(fetchPersonalStateOverview({ profile: 'default', query: 'dashboard' })).resolves.toEqual({ profile: 'default' })

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/personal-state/overview?profile=default&query=dashboard')
  })

  it('posts proposal and task review actions', async () => {
    mockRequest
      .mockResolvedValueOnce({ proposal: { id: 'proposal-1', status: 'approved' } })
      .mockResolvedValueOnce({ proposal: { id: 'proposal-1', status: 'rejected' } })
      .mockResolvedValueOnce({ task: { id: 'task-1', status: 'done' } })

    await approvePersonalStateProposal('proposal-1', 'default')
    await rejectPersonalStateProposal('proposal-1', 'default')
    await checkInPersonalStateTask('task-1', 'default')

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/personal-state/proposals/proposal-1/approve?profile=default', { method: 'POST' }],
      ['/api/hermes/personal-state/proposals/proposal-1/reject?profile=default', { method: 'POST' }],
      ['/api/hermes/personal-state/tasks/task-1/check-in?profile=default', { method: 'POST' }],
    ])
  })
})
