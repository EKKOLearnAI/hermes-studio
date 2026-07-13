import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealthIngestionEnvelope } from '../../packages/server/src/services/hermes/health-loop'

describe('health-loop connectors', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-health-connectors-'))
    process.env.HERMES_HOME = root
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    await rm(root, { recursive: true, force: true })
  })

  it('registers connectors deterministically and rejects duplicate or invalid ids', async () => {
    const { createHealthConnectorRegistry } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const connector = (id: string) => ({
      id,
      domains: ['diet'] as const,
      status: vi.fn(),
      sync: vi.fn(),
    })

    const registry = createHealthConnectorRegistry([connector('z-source'), connector('a-source')])
    expect(registry.list().map(item => item.id)).toEqual(['a-source', 'z-source'])
    expect(registry.get('a-source')?.id).toBe('a-source')
    expect(registry.get('missing')).toBeUndefined()
    expect(() => createHealthConnectorRegistry([connector('same'), connector('same')])).toThrow(/CONNECTOR_DUPLICATE_ID/)
    expect(() => createHealthConnectorRegistry([connector('../bad')])).toThrow(/CONNECTOR_INVALID_ID/)
  })

  it('maps S400 readings through ingestion once and never exposes provider secrets', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createS400HealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/s400')
    const ingested: HealthIngestionEnvelope[] = []
    const stateStore = new FileHealthConnectorStateStore(join(root, 'connectors.json'))
    const getSettings = vi.fn(async () => ({
      enabled: true, configured: true, source: 'xiaomihome', username: 'secret@example.com', hasPassword: true,
      passwordMasked: '********', region: 'cn', scaleModel: 'yunmai.scales.ms103', scaleconnectPath: 'C:\\secret\\scaleconnect.exe',
    }))
    const runSync = vi.fn(async () => ({
      status: 'synced' as const,
      importedCount: 1,
      readings: [{
        id: 'health-scale-reading-abc', kind: 'scale_reading', recordedAt: '2026-07-13T00:00:00.000Z',
        value: { measuredAt: '2026-07-13T00:00:00.000Z', sourceDevice: 'S400', sourceModel: 'ms103', weightKg: 82.4, bodyFatPercent: 20.1 },
      }],
    }))
    const connector = createS400HealthConnector({ stateStore, getSettings, runSync, ingest: envelope => { ingested.push(envelope); return {} as never } })

    const first = await connector.sync({ now: '2026-07-13T01:00:00Z' })
    const second = await connector.sync({ now: '2026-07-13T02:00:00Z' })
    const status = await connector.status()

    expect(first).toMatchObject({ connectorId: 's400', attemptedCount: 1, ingestedCount: 1 })
    expect(second.cursor).toBe(first.cursor)
    expect(ingested).toHaveLength(2)
    expect(ingested[0]).toMatchObject({
      domain: 'body_composition', source: 's400', sourceId: 'health-scale-reading-abc',
      observedAt: '2026-07-13T00:00:00.000Z', evidenceClass: 'measured', confidence: 1,
      payload: { weightKg: 82.4, bodyFatPercent: 20.1, deviceModel: 'ms103' },
    })
    expect(status).toMatchObject({
      configured: true, health: 'healthy', domains: ['body_composition'],
      lastAttemptAt: '2026-07-13T02:00:00Z', lastSuccessAt: '2026-07-13T02:00:00Z', cursor: first.cursor,
    })
    expect(JSON.stringify(status)).not.toMatch(/secret@example|scaleconnect|password|username/i)
    expect(await readFile(join(root, 'connectors.json'), 'utf8')).not.toMatch(/secret@example|scaleconnect|password|username/i)
  })

  it('makes replayed S400 provider readings a Twin no-op', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createS400HealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/s400')
    const { listTwinEvents, listTwinObservations } = await import('../../packages/server/src/services/hermes/personal-twin')
    const reading = {
      id: 'health-scale-reading-replay', kind: 'scale_reading', recordedAt: '2026-07-13T00:00:00Z',
      value: { measuredAt: '2026-07-13T00:00:00Z', sourceDevice: 'S400', sourceModel: 'ms103', weightKg: 82.4, bodyFatPercent: 20.1 },
    }
    const connector = createS400HealthConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 's400-replay.json')),
      getSettings: async () => ({ configured: true }),
      runSync: async () => ({ status: 'synced', importedCount: 1, readings: [reading] }),
    })

    await connector.sync({ now: '2026-07-13T01:00:00Z' })
    const firstIds = listTwinObservations({ entityId: 'person:self' }).map(item => item.id)
    await connector.sync({ now: '2026-07-13T02:00:00Z' })

    expect(listTwinObservations({ entityId: 'person:self' }).map(item => item.id)).toEqual(firstIds)
    expect(listTwinEvents({ subjectId: 'person:self', eventType: 'health.ingestion.recorded' })).toHaveLength(1)
  })

  it('imports raw legacy diet, fitness, and sleep records with their source timestamps', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createHealthStateConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/health-state')
    const envelopes: HealthIngestionEnvelope[] = []
    const connector = createHealthStateConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 'state.json')),
      readSource: () => ({
        foodLogs: [{ id: 'meal-1', loggedAt: '2026-07-12T12:00:00Z', quantity: 1, unit: 'serving', nutrition: { calories: 510, protein: 31, carbs: 62, fat: 14, water: 300 } }],
        workouts: [{ id: 'workout-1', title: 'Squat', durationMinutes: 45, intensity: 'vigorous', startedAt: '2026-07-12T10:00:00Z', metrics: { pain: 1, rpe: 8, completed: true } }],
        dailyCheckins: [{ id: 'checkin-1', checkin_date: '2026-07-13', sleep_json: JSON.stringify({ startedAt: '2026-07-12T23:00:00Z', endedAt: '2026-07-13T06:30:00Z', durationMinutes: 450, interruptions: 1, subjectiveRecovery: 8 }) }],
        recentWorkouts: [{ id: 'display-only', title: 'must-not-import' }],
        nutritionSummary: { consumed: { calories: 9999 } },
      }),
      ingest: envelope => { envelopes.push(envelope); return {} as never },
    })

    const batch = await connector.sync({ now: '2026-07-13T09:00:00Z' })

    expect(batch).toMatchObject({ attemptedCount: 3, ingestedCount: 3 })
    expect(envelopes.map(item => item.domain)).toEqual(['fitness', 'diet', 'sleep'])
    expect(envelopes).toContainEqual(expect.objectContaining({ domain: 'diet', sourceId: 'food-log:meal-1', observedAt: '2026-07-12T12:00:00Z' }))
    expect(envelopes).toContainEqual(expect.objectContaining({ domain: 'fitness', sourceId: 'workout:workout-1', observedAt: '2026-07-12T10:00:00Z' }))
    expect(envelopes).toContainEqual(expect.objectContaining({ domain: 'sleep', sourceId: 'sleep:checkin-1', observedAt: '2026-07-13T06:30:00Z' }))
    expect(JSON.stringify(envelopes)).not.toContain('display-only')
    expect(JSON.stringify(envelopes)).not.toContain('9999')
  })

  it('accepts strict structured JSON and CSV for diet, fitness, and sleep', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const envelopes: HealthIngestionEnvelope[] = []
    const store = new FileHealthConnectorStateStore(join(root, 'structured.json'))
    const ingest = (envelope: HealthIngestionEnvelope) => { envelopes.push(envelope); return {} as never }
    const json = createStructuredImportConnector({
      id: 'structured-json', format: 'json', stateStore: store, ingest,
      content: JSON.stringify([
        { domain: 'diet', sourceId: 'd1', observedAt: '2026-07-13T01:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { caloriesKcal: 500, proteinG: 30 } },
        { domain: 'fitness', sourceId: 'f1', observedAt: '2026-07-13T02:00:00Z', evidenceClass: 'reported', confidence: 0.9, payload: { exercise: 'run', durationMinutes: 30 } },
        { domain: 'sleep', sourceId: 's1', observedAt: '2026-07-13T03:00:00Z', evidenceClass: 'measured', confidence: 0.95, payload: { durationMinutes: 440, interruptions: 2 } },
      ]),
    })
    const csv = createStructuredImportConnector({
      id: 'structured-csv', format: 'csv', stateStore: store, ingest,
      content: [
        'domain,sourceId,observedAt,evidenceClass,confidence,caloriesKcal,proteinG,exercise,durationMinutes,interruptions',
        'diet,csv-d,2026-07-13T04:00:00Z,reported,1,600,40,,,',
        'fitness,csv-f,2026-07-13T05:00:00Z,reported,1,,,cycle,35,',
        'sleep,csv-s,2026-07-13T06:00:00Z,reported,1,,,,420,1',
      ].join('\n'),
    })

    await expect(json.sync({ now: '2026-07-13T07:00:00Z' })).resolves.toMatchObject({ ingestedCount: 3 })
    await expect(csv.sync({ now: '2026-07-13T07:00:00Z' })).resolves.toMatchObject({ ingestedCount: 3 })
    expect(envelopes.map(item => item.domain)).toEqual(['diet', 'fitness', 'sleep', 'diet', 'fitness', 'sleep'])
  })

  it('fails closed on malformed structured input, unknown fields, CSV injection, and limits', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const stateStore = new FileHealthConnectorStateStore(join(root, 'invalid.json'))
    const make = (id: string, format: 'json' | 'csv', content: string) => createStructuredImportConnector({ id, format, content, stateStore, ingest: () => ({} as never) })

    const cases = [
      make('bad-json', 'json', '[{"domain":"diet"}'),
      make('unknown-json', 'json', JSON.stringify([{ domain: 'diet', sourceId: 'd', observedAt: '2026-07-13T00:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { caloriesKcal: 1 }, token: 'secret' }])),
      make('bad-domain', 'csv', 'domain,sourceId,observedAt,evidenceClass,confidence,exercise\nposture,p1,2026-07-13T00:00:00Z,reported,1,test'),
      make('csv-injection', 'csv', 'domain,sourceId,observedAt,evidenceClass,confidence,exercise\nfitness,f1,2026-07-13T00:00:00Z,reported,1,=CMD()'),
      make('too-large', 'json', `[]${'x'.repeat(1_048_577)}`),
    ]
    for (const connector of cases) {
      await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_(INVALID_IMPORT|IMPORT_LIMIT)/)
    }
  })

  it('advances the cursor only after the entire batch commits and replays a committed prefix safely', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const stateStore = new FileHealthConnectorStateStore(join(root, 'cursor.json'))
    let failSecond = true
    const calls: string[] = []
    const connector = createStructuredImportConnector({
      id: 'cursor-source', format: 'json', stateStore,
      content: JSON.stringify([
        { domain: 'diet', sourceId: 'first', observedAt: '2026-07-13T01:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { caloriesKcal: 100 } },
        { domain: 'diet', sourceId: 'second', observedAt: '2026-07-13T02:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { caloriesKcal: 200 } },
      ]),
      ingest: envelope => {
        calls.push(envelope.sourceId)
        if (failSecond && envelope.sourceId === 'second') throw new Error('C:\\private\\token=secret')
        return {} as never
      },
    })

    await expect(connector.sync({ now: '2026-07-13T03:00:00Z' })).rejects.toThrow(/CONNECTOR_SYNC_FAILED/)
    const failedStatus = await connector.status()
    expect(failedStatus).toMatchObject({ health: 'degraded', errorCode: 'CONNECTOR_SYNC_FAILED' })
    expect(failedStatus.cursor).toBeUndefined()
    expect(JSON.stringify(failedStatus)).not.toMatch(/private|token|secret/i)

    failSecond = false
    const success = await connector.sync({ now: '2026-07-13T04:00:00Z' })
    expect(calls).toEqual(['first', 'second', 'first', 'second'])
    const healthyStatus = await connector.status()
    expect(healthyStatus).toMatchObject({ health: 'healthy', cursor: success.cursor })
    expect(healthyStatus.errorCode).toBeUndefined()
    const { createConnectorCursor } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    await expect(connector.sync({ cursor: createConnectorCursor('2026-07-12T00:00:00Z', 'old'), now: '2026-07-13T05:00:00Z' }))
      .rejects.toThrow(/CONNECTOR_CURSOR_CONFLICT/)
  })

  it('validates now/cursor, handles empty batches, and fails closed on corrupt persisted state', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const path = join(root, 'state.json')
    const connector = createStructuredImportConnector({
      id: 'empty-source', format: 'json', content: '[]', stateStore: new FileHealthConnectorStateStore(path), ingest: () => ({} as never),
    })

    await expect(connector.sync({ now: 'not-a-time' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ now: '2026-02-30T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ cursor: '../bad', now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_CURSOR/)
    await expect(connector.sync({ cursor: 'stale', now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_CURSOR/)
    await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).resolves.toMatchObject({ attemptedCount: 0, ingestedCount: 0 })
    await writeFile(path, '{"empty-source":{"cursor":"../../escape"}}', 'utf8')
    expect(await connector.status()).toMatchObject({ configured: true, health: 'unavailable', errorCode: 'CONNECTOR_STATE_CORRUPT' })
    await expect(connector.sync({ now: '2026-07-13T02:00:00Z' })).rejects.toThrow(/CONNECTOR_STATE_CORRUPT/)
  })

  it('distinguishes provider status failure from corrupt local state without leaking details', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createS400HealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/s400')
    const connector = createS400HealthConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 'provider-status.json')),
      getSettings: async () => { throw new Error('C:\\private\\token=secret') },
    })

    const status = await connector.status()
    expect(status).toMatchObject({ configured: false, health: 'unavailable', errorCode: 'CONNECTOR_STATUS_FAILED' })
    expect(JSON.stringify(status)).not.toMatch(/private|token|secret/i)
  })
})
