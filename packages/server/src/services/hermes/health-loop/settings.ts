import { createHash } from 'crypto'
import { stableTwinId, upsertTwinEntity } from '../personal-twin/store'
import { withPersonalTwinDb } from '../personal-twin/database'

export interface HealthAutomationSettings {
  subjectId: string
  liveDeliveryEnabled: boolean
  profile: string
  recipient: 'configured-self'
  configuredConnectors: string[]
  configuredProcessors: string[]
  version: number
  actorUserId: string
  updatedAt: string
}

export interface UpdateHealthAutomationSettingsInput {
  expectedVersion: number
  liveDeliveryEnabled: boolean
  actorUserId: string
  profile: string
  recipient: 'configured-self'
  configuredConnectors?: string[]
  configuredProcessors?: string[]
  subjectId?: string
  updatedAt?: string
}

const DEFAULT_SUBJECT = 'person:self'

export function getHealthAutomationSettings(subjectId = DEFAULT_SUBJECT): HealthAutomationSettings {
  validateSubject(subjectId)
  ensureSettings(subjectId)
  return withPersonalTwinDb(db => rowToSettings(db.prepare(
    'SELECT * FROM twin_health_automation_settings WHERE subject_id=?',
  ).get(subjectId) as unknown as SettingsRow))
}

export function updateHealthAutomationSettings(input: UpdateHealthAutomationSettingsInput): HealthAutomationSettings {
  const subjectId = input.subjectId ?? DEFAULT_SUBJECT
  validateSubject(subjectId)
  validateId(input.actorUserId, 160)
  const profile = validateProfile(input.profile)
  if (input.recipient !== 'configured-self' || typeof input.liveDeliveryEnabled !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('HEALTH_SETTINGS_INVALID')
  const connectors = canonicalIds(input.configuredConnectors ?? [])
  const processors = canonicalIds(input.configuredProcessors ?? [])
  const updatedAt = timestamp(input.updatedAt ?? new Date().toISOString())
  ensureSettings(subjectId)
  return withPersonalTwinDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare('SELECT * FROM twin_health_automation_settings WHERE subject_id=?')
        .get(subjectId) as unknown as SettingsRow
      if (current.version !== input.expectedVersion) throw new Error('HEALTH_SETTINGS_CONFLICT')
      const version = current.version + 1
      const changed = db.prepare(`UPDATE twin_health_automation_settings SET live_delivery_enabled=?,profile=?,recipient=?,
        configured_connectors_json=?,configured_processors_json=?,version=?,actor_user_id=?,updated_at=?
        WHERE subject_id=? AND version=?`).run(Number(input.liveDeliveryEnabled), profile, input.recipient,
        JSON.stringify(connectors), JSON.stringify(processors), version, input.actorUserId, updatedAt,
        subjectId, input.expectedVersion)
      if (changed.changes !== 1) throw new Error('HEALTH_SETTINGS_CONFLICT')
      appendSettingsAudit(db, { subjectId, version, actor: input.actorUserId, updatedAt,
        live: input.liveDeliveryEnabled, profile, connectors, processors })
      const row = db.prepare('SELECT * FROM twin_health_automation_settings WHERE subject_id=?').get(subjectId) as unknown as SettingsRow
      db.exec('COMMIT')
      return rowToSettings(row)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
}

function ensureSettings(subjectId: string): void {
  upsertTwinEntity({ id: subjectId, type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
  withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_health_automation_settings
    (subject_id,live_delivery_enabled,profile,recipient,configured_connectors_json,configured_processors_json,
      version,actor_user_id,updated_at)
    VALUES(?,0,'default','configured-self','[]','[]',1,'system','1970-01-01T00:00:00.000Z')
    ON CONFLICT(subject_id) DO NOTHING`).run(subjectId))
}

function appendSettingsAudit(db: import('node:sqlite').DatabaseSync, input: {
  subjectId:string; version:number; actor:string; updatedAt:string; live:boolean; profile:string;
  connectors:string[]; processors:string[]
}): void {
  const sourceId = `settings-v${input.version}`
  const eventType = 'health.automation.settings_changed'
  const id = stableTwinId('event', ['health-runtime', sourceId, eventType])
  const payload = { schemaVersion: 1, settingsVersion: input.version, liveDeliveryEnabled: input.live,
    profile: input.profile, connectorCount: input.connectors.length, processorCount: input.processors.length,
    configurationDigest: createHash('sha256').update(JSON.stringify({ c: input.connectors, p: input.processors })).digest('hex') }
  db.prepare(`INSERT INTO twin_events
    (id,event_type,subject_id,payload_json,occurred_at,ingested_at,source,source_id,actor,confidence,
      confirmation_state,evidence_json,schema_version)
    VALUES(?,?,?,?,?,?,'health-runtime',?,?,1,'confirmed','[]',1)`).run(
    id, eventType, input.subjectId, JSON.stringify(payload), input.updatedAt, input.updatedAt, sourceId, input.actor,
  )
  const outboxId = stableTwinId('outbox', ['twin.event.recorded', id])
  db.prepare(`INSERT INTO twin_outbox(id,topic,aggregate_id,payload_json,status,available_at,created_at)
    VALUES(?,'twin.event.recorded',?,?, 'pending',?,?)`).run(outboxId, id,
    JSON.stringify({ recordId: id, eventType, source: 'health-runtime', sourceId }), input.updatedAt, input.updatedAt)
}

interface SettingsRow {
  subject_id:string; live_delivery_enabled:number; profile:string; recipient:'configured-self'
  configured_connectors_json:string; configured_processors_json:string; version:number
  actor_user_id:string; updated_at:string
}

function rowToSettings(row: SettingsRow): HealthAutomationSettings {
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || ![0,1].includes(row.live_delivery_enabled)
    || row.recipient !== 'configured-self') throw new Error('HEALTH_SETTINGS_CORRUPT')
  return { subjectId: row.subject_id, liveDeliveryEnabled: row.live_delivery_enabled === 1,
    profile: validateProfile(row.profile), recipient: row.recipient,
    configuredConnectors: parseIds(row.configured_connectors_json),
    configuredProcessors: parseIds(row.configured_processors_json), version: row.version,
    actorUserId: row.actor_user_id, updatedAt: timestamp(row.updated_at) }
}

function parseIds(value: string): string[] {
  try { return canonicalIds(JSON.parse(value) as unknown) } catch { throw new Error('HEALTH_SETTINGS_CORRUPT') }
}
function canonicalIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('HEALTH_SETTINGS_INVALID')
  const ids = value.map(item => { if (typeof item !== 'string') throw new Error('HEALTH_SETTINGS_INVALID'); validateId(item, 160); return item })
  if (new Set(ids).size !== ids.length) throw new Error('HEALTH_SETTINGS_INVALID')
  return [...ids].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}
function validateSubject(value: string): void { if (value !== DEFAULT_SUBJECT) throw new Error('HEALTH_SETTINGS_INVALID') }
function validateProfile(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('HEALTH_SETTINGS_INVALID')
  }
  return value
}
function validateId(value: string, maximum: number): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error('HEALTH_SETTINGS_INVALID')
}
function timestamp(value: string): string {
  const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error('HEALTH_SETTINGS_INVALID')
  return new Date(time).toISOString()
}
