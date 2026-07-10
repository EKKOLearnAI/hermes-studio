import { withPersonalTwinDb } from './database'
import { getTwinEntity, listTwinEntities, listTwinEvents, listTwinObservations, upsertTwinEntity } from './store'
import { TwinEntity, TwinOverview } from './types'

const DOMAIN_PREFIXES: Record<string, string[]> = {
  body: ['body.'], health: ['health.'], fitness: ['fitness.'], nutrition: ['nutrition.'],
  home: ['home.'], life: ['life.'], work: ['work.'], entertainment: ['entertainment.', 'bilibili.'],
  commerce: ['commerce.', 'food_delivery.'], digital: ['digital.', 'app.', 'account.'],
}

function clampLimit(value: number | undefined): number { return value === undefined || !Number.isFinite(value) ? 50 : Math.max(1, Math.min(200, Math.floor(value))) }
export function ensurePrimarySubject(): TwinEntity {
  return getTwinEntity('person:self') || upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
}

export function getPersonalTwinOverview(): TwinOverview {
  const subject = ensurePrimarySubject()
  const latestObservations = listTwinObservations({ entityId: subject.id, limit: 20 })
  const recentEvents = listTwinEvents({ subjectId: subject.id, limit: 20 })
  const counts = withPersonalTwinDb(db => ({
    entities: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_entities').get() as { count: number }).count),
    relations: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_relations').get() as { count: number }).count),
    observations: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_observations').get() as { count: number }).count),
    events: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_events').get() as { count: number }).count),
    goals: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_goals').get() as { count: number }).count),
    constraints: Number((db.prepare('SELECT COUNT(*) AS count FROM twin_constraints').get() as { count: number }).count),
    pendingOutbox: Number((db.prepare("SELECT COUNT(*) AS count FROM twin_outbox WHERE status = 'pending'").get() as { count: number }).count),
  }))
  const imports = withPersonalTwinDb(db => db.prepare('SELECT id, source, status, counts_json, started_at, completed_at FROM twin_import_runs ORDER BY datetime(started_at) DESC, id DESC LIMIT 20').all().map(row => row as Record<string, unknown>))
  return { generatedAt: new Date().toISOString(), subject, counts, latestObservations, recentEvents, imports }
}

export function getPersonalTwinContext(options: { domains?: string[]; query?: string; limit?: number } = {}): {
  subject: TwinEntity
  observations: ReturnType<typeof listTwinObservations>
  events: ReturnType<typeof listTwinEvents>
} {
  const subject = ensurePrimarySubject()
  const prefixes = (options.domains || []).flatMap(domain => DOMAIN_PREFIXES[domain] || [])
  const limit = clampLimit(options.limit)
  const observations = listTwinObservations({ metricPrefixes: prefixes, query: options.query, limit })
  const events = listTwinEvents({ eventTypePrefixes: prefixes, query: options.query, limit })
  return { subject, observations, events }
}
