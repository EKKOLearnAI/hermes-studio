import { request } from '@/api/client'

export interface PersonalTwinEntity { id: string; type: string; label: string; attributes: Record<string, unknown>; source: string; sourceId: string; createdAt: string; updatedAt: string }
export interface PersonalTwinObservation { id: string; entityId: string; metric: string; value: unknown; unit: string | null; observedAt: string; ingestedAt: string; provenance: Record<string, unknown> }
export interface PersonalTwinEvent { id: string; eventType: string; subjectId: string | null; payload: Record<string, unknown>; occurredAt: string; ingestedAt: string; provenance: Record<string, unknown> }
export interface PersonalTwinOverview { generatedAt: string; subject: PersonalTwinEntity; counts: Record<string, number>; latestObservations: PersonalTwinObservation[]; recentEvents: PersonalTwinEvent[]; imports: Array<Record<string, unknown>> }
export interface PersonalTwinContext { subject: PersonalTwinEntity; observations: PersonalTwinObservation[]; events: PersonalTwinEvent[] }
export interface PersonalTwinImportResult { runId: string; profiles: string[]; status: 'completed' | 'failed'; counts: Record<string, number>; startedAt: string; completedAt: string }

function queryPath(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export async function fetchPersonalTwinOverview(): Promise<PersonalTwinOverview> {
  const response = await request<{ overview: PersonalTwinOverview }>('/api/hermes/personal-twin/overview')
  return response.overview
}

export async function fetchPersonalTwinEntities(options: { type?: string; source?: string; limit?: number } = {}): Promise<PersonalTwinEntity[]> {
  const response = await request<{ entities: PersonalTwinEntity[] }>(queryPath('/api/hermes/personal-twin/entities', options))
  return response.entities
}

export async function fetchPersonalTwinObservations(options: { entityId?: string; metric?: string; limit?: number } = {}): Promise<PersonalTwinObservation[]> {
  const response = await request<{ observations: PersonalTwinObservation[] }>(queryPath('/api/hermes/personal-twin/observations', options))
  return response.observations
}

export async function fetchPersonalTwinEvents(options: { subjectId?: string; eventType?: string; limit?: number } = {}): Promise<PersonalTwinEvent[]> {
  const response = await request<{ events: PersonalTwinEvent[] }>(queryPath('/api/hermes/personal-twin/events', options))
  return response.events
}

export async function fetchPersonalTwinContext(options: { domains?: string[]; query?: string; limit?: number } = {}): Promise<PersonalTwinContext> {
  const response = await request<{ context: PersonalTwinContext }>(queryPath('/api/hermes/personal-twin/context', {
    domains: options.domains?.join(','), query: options.query, limit: options.limit,
  }))
  return response.context
}

export async function syncLegacyPersonalTwin(profiles?: string[]): Promise<PersonalTwinImportResult> {
  const response = await request<{ result: PersonalTwinImportResult }>('/api/hermes/personal-twin/imports/legacy', {
    method: 'POST',
    body: JSON.stringify(profiles ? { profiles } : {}),
  })
  return response.result
}
