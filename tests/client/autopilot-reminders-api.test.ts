// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  fetchAutopilotReminderDeliveries,
  fetchAutopilotReminderSettings,
  sendAutopilotReminderTest,
  updateAutopilotReminderSettings,
} from '../../packages/client/src/api/hermes/autopilot-reminders'

describe('Autopilot Reminders API', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  it('fetches reminder settings with optional profile params', async () => {
    mockRequest.mockResolvedValueOnce({ settings: { enabled: false } })

    const settings = await fetchAutopilotReminderSettings('default')

    expect(settings).toEqual({ enabled: false })
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/autopilot-reminders/settings?profile=default')
  })

  it('updates reminder settings', async () => {
    mockRequest.mockResolvedValueOnce({ settings: { enabled: true } })

    const settings = await updateAutopilotReminderSettings({ enabled: true }, 'default')

    expect(settings).toEqual({ enabled: true })
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/autopilot-reminders/settings?profile=default', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
  })

  it('lists reminder deliveries', async () => {
    mockRequest.mockResolvedValueOnce({ deliveries: [{ id: 'delivery-1' }] })

    const deliveries = await fetchAutopilotReminderDeliveries('default')

    expect(deliveries).toEqual([{ id: 'delivery-1' }])
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/autopilot-reminders/deliveries?profile=default')
  })

  it('sends a test reminder', async () => {
    mockRequest.mockResolvedValueOnce({ result: { status: 'sent' } })

    const result = await sendAutopilotReminderTest('default')

    expect(result).toEqual({ status: 'sent' })
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/autopilot-reminders/test?profile=default', {
      method: 'POST',
    })
  })
})
