// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  createPersonalAutopilotQuickLog,
  fetchPersonalAutopilotOverview,
} from '../../packages/client/src/api/hermes/personal-autopilot'

describe('Personal Autopilot API', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  it('fetches the autopilot overview with optional profile params', async () => {
    mockRequest.mockResolvedValueOnce({ overview: { mode: 'nudge' } })

    const overview = await fetchPersonalAutopilotOverview({ profile: 'default' })

    expect(overview).toEqual({ mode: 'nudge' })
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/personal-autopilot/overview?profile=default')
  })

  it('creates a quick log with optional profile params', async () => {
    mockRequest.mockResolvedValueOnce({ log: { kind: 'skin' } })

    const log = await createPersonalAutopilotQuickLog({ text: '脸出油', kind: 'skin' }, 'default')

    expect(log).toEqual({ kind: 'skin' })
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/personal-autopilot/quick-log?profile=default', {
      method: 'POST',
      body: JSON.stringify({ text: '脸出油', kind: 'skin' }),
    })
  })
})
