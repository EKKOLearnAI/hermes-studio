import { request } from '@/api/client'

export type PersonalAutopilotMode = 'silent' | 'nudge' | 'correct' | 'takeover' | 'upgrade'
export type PersonalAutopilotDomain = 'body' | 'diet' | 'skin' | 'recovery' | 'order' | 'planning'

export interface PersonalAutopilotOverview {
  generatedAt: string
  mode: PersonalAutopilotMode
  state: {
    body: string
    diet: string
    skin: string
    recovery: string
    order: string
  }
  nextAction: {
    id: string
    domain: PersonalAutopilotDomain
    title: string
    reason: string
    sourceId: string | null
    fallbackTitle: string
  }
  signals: Array<{ key: string; label: string; status: string; value: string }>
}

function withProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}profile=${encodeURIComponent(profile)}`
}

export async function fetchPersonalAutopilotOverview(options: { profile?: string | null } = {}): Promise<PersonalAutopilotOverview> {
  const res = await request<{ overview: PersonalAutopilotOverview }>(
    withProfile('/api/hermes/personal-autopilot/overview', options.profile),
  )
  return res.overview
}
