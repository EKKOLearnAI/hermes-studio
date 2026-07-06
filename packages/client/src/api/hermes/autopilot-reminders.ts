import { request } from '@/api/client'

export interface AutopilotReminderSettings {
  profile: string
  enabled: boolean
  channel: 'weixin'
  dailyLimit: number
  minimumIntervalMinutes: number
  quietStart: string
  quietEnd: string
  createdAt: string | null
  updatedAt: string | null
}

export interface AutopilotReminderDelivery {
  id: string
  profile: string
  channel: 'weixin'
  mode: string
  actionId: string | null
  actionTitle: string
  message: string
  status: 'sent' | 'skipped' | 'failed'
  error: string | null
  sentAt: string
  createdAt: string
}

export interface AutopilotReminderDispatchResult {
  status: 'sent' | 'skipped' | 'failed'
  reason: string
  delivery?: AutopilotReminderDelivery
}

function withProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}profile=${encodeURIComponent(profile)}`
}

export async function fetchAutopilotReminderSettings(profile?: string | null): Promise<AutopilotReminderSettings> {
  const res = await request<{ settings: AutopilotReminderSettings }>(
    withProfile('/api/hermes/autopilot-reminders/settings', profile),
  )
  return res.settings
}

export async function updateAutopilotReminderSettings(
  payload: Partial<AutopilotReminderSettings>,
  profile?: string | null,
): Promise<AutopilotReminderSettings> {
  const res = await request<{ settings: AutopilotReminderSettings }>(
    withProfile('/api/hermes/autopilot-reminders/settings', profile),
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
  return res.settings
}

export async function fetchAutopilotReminderDeliveries(profile?: string | null): Promise<AutopilotReminderDelivery[]> {
  const res = await request<{ deliveries: AutopilotReminderDelivery[] }>(
    withProfile('/api/hermes/autopilot-reminders/deliveries', profile),
  )
  return res.deliveries
}

export async function sendAutopilotReminderTest(profile?: string | null): Promise<AutopilotReminderDispatchResult> {
  const res = await request<{ result: AutopilotReminderDispatchResult }>(
    withProfile('/api/hermes/autopilot-reminders/test', profile),
    { method: 'POST' },
  )
  return res.result
}
