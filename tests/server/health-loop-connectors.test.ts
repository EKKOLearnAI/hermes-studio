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

  it('isolates connector state keys from Object prototype properties', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    for (const id of ['constructor', 'toString']) {
      for (const legacy of [false, true]) {
        const path = join(root, `${id}-${legacy ? 'legacy' : 'missing'}.json`)
        if (legacy) await writeFile(path, JSON.stringify({ version: 1, connectors: {} }), 'utf8')
        const connector = createStructuredImportConnector({
          id, format: 'json', content: '[]', stateStore: new FileHealthConnectorStateStore(path), ingest: () => ({} as never),
        })

        expect(await connector.status()).toMatchObject({ configured: true, health: 'unavailable' })
        await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).resolves.toMatchObject({ attemptedCount: 0 })
        expect(await connector.status()).toMatchObject({ health: 'healthy', lastSuccessAt: '2026-07-13T01:00:00Z' })
      }
    }
  }, 15_000)

  it('keeps a successful sync distinct from a degraded connector health report', async () => {
    const { FileHealthConnectorStateStore, createManagedHealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const connector = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 'degraded.json')),
      ingest: () => ({} as never),
      source: {
        id: 'degraded-source', domains: ['diet'], capabilities: { read: ['diet'], write: [] },
        access: async () => ({ configurationState: 'configured', authorizationState: 'not_required' }),
        load: async () => ({ envelopes: [], health: 'degraded' }),
      },
    })

    await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).resolves.toMatchObject({ ingestedCount: 0 })
    expect(await connector.status()).toMatchObject({ health: 'degraded', lastSuccessAt: '2026-07-13T01:00:00Z', freshnessByDomain: {} })
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
    expect(ingested).toHaveLength(1)
    expect(ingested[0]).toMatchObject({
      domain: 'body_composition', source: 's400', sourceId: 'health-scale-reading-abc',
      observedAt: '2026-07-13T00:00:00.000Z', evidenceClass: 'measured', confidence: 1,
      payload: { weightKg: 82.4, bodyFatPercent: 20.1, deviceModel: 'ms103' },
    })
    expect(status).toMatchObject({
      configured: true, configurationState: 'configured', authorizationState: 'authorized', health: 'healthy', domains: ['body_composition'],
      lastAttemptAt: '2026-07-13T02:00:00Z', lastSuccessAt: '2026-07-13T02:00:00Z', cursor: first.cursor,
      freshnessByDomain: { body_composition: '2026-07-13T00:00:00.000Z' },
      capabilities: { read: ['body_composition'], write: [] },
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

  it('skips a real mood-only check-in but fails closed on non-empty invalid sleep data', async () => {
    const { createHealthCheckIn } = await import('../../packages/server/src/services/hermes/health-state')
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createHealthStateConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/health-state')
    createHealthCheckIn({ id: 'mood-only', checkinDate: '2026-07-13', mood: 'good', energy: 8 }, 'tester', 'default')
    const connector = createHealthStateConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 'real-health-state.json')),
      ingest: () => ({} as never),
    })

    await expect(connector.sync({ now: '2026-07-13T23:00:00Z' })).resolves.toMatchObject({ attemptedCount: 0 })
    createHealthCheckIn({ id: 'bad-sleep', checkinDate: '2026-07-14', sleep: { mysteryStage: 30 } }, 'tester', 'default')
    await expect(connector.sync({ now: '2026-07-14T23:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_IMPORT/)
  })

  it('treats the S400 cursor as a monotonic (cursor, now] watermark', async () => {
    const { FileHealthConnectorStateStore, createConnectorCursor } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createS400HealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/s400')
    const imported: string[] = []
    const reading = (id: string, measuredAt: string) => ({ id, kind: 'scale_reading', recordedAt: measuredAt,
      value: { measuredAt, sourceDevice: 'S400', sourceModel: 'ms103', weightKg: 82.4 } })
    const batches = [
      [reading('reading-old', '2026-07-13T00:00:00Z'), reading('reading-m', '2026-07-13T01:00:00Z'), reading('reading-future', '2026-07-13T04:00:00Z')],
      [reading('reading-old', '2026-07-13T00:00:00Z'), reading('reading-m', '2026-07-13T01:00:00Z')],
      [reading('reading-m', '2026-07-13T01:00:00Z'), reading('reading-z', '2026-07-13T01:00:00Z')],
    ]
    let run = 0
    const connector = createS400HealthConnector({
      stateStore: new FileHealthConnectorStateStore(join(root, 's400-watermark.json')),
      getSettings: async () => ({ configured: true }),
      runSync: async () => ({ status: 'synced', importedCount: batches[run].length, readings: batches[run++] }),
      ingest: envelope => { imported.push(envelope.sourceId); return {} as never },
    })
    const seed = createConnectorCursor('2026-07-13T00:30:00Z', 'seed')

    const first = await connector.sync({ cursor: seed, now: '2026-07-13T02:00:00Z' })
    expect(imported).toEqual(['reading-m'])
    const second = await connector.sync({ now: '2026-07-13T03:00:00Z' })
    expect(second.cursor).toBe(first.cursor)
    expect(imported).toEqual(['reading-m'])
    const third = await connector.sync({ now: '2026-07-13T03:00:00Z' })
    expect(imported).toEqual(['reading-m', 'reading-z'])
    expect(third.cursor).not.toBe(first.cursor)
    await expect(connector.sync({ cursor: seed, now: '2026-07-13T03:00:00Z' })).rejects.toThrow(/CONNECTOR_CURSOR_CONFLICT/)
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
      make('nested-food-secret', 'json', JSON.stringify([{ domain: 'diet', sourceId: 'd2', observedAt: '2026-07-13T00:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { foods: [{ name: 'rice', portionGrams: 100, token: 'secret' }] } }])),
      make('nested-set-secret', 'json', JSON.stringify([{ domain: 'fitness', sourceId: 'f2', observedAt: '2026-07-13T00:00:00Z', evidenceClass: 'reported', confidence: 1, payload: { exercises: [{ name: 'squat', sets: [{ reps: 5, token: 'secret' }] }] } }])),
      make('nested-stage-secret', 'json', JSON.stringify([{ domain: 'sleep', sourceId: 's2', observedAt: '2026-07-13T00:00:00Z', evidenceClass: 'measured', confidence: 1, payload: { stages: { deepMinutes: 60, token: 1 } } }])),
      make('bad-domain', 'csv', 'domain,sourceId,observedAt,evidenceClass,confidence,exercise\nposture,p1,2026-07-13T00:00:00Z,reported,1,test'),
      make('csv-injection', 'csv', 'domain,sourceId,observedAt,evidenceClass,confidence,exercise\nfitness,f1,2026-07-13T00:00:00Z,reported,1,=CMD()'),
      make('too-large', 'json', `[]${'x'.repeat(1_048_577)}`),
    ]
    for (const connector of cases) {
      await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_(INVALID_IMPORT|IMPORT_LIMIT)/)
    }
  })

  it('validates and flattens a strict structured diet macros object', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const envelopes: HealthIngestionEnvelope[] = []
    const connector = createStructuredImportConnector({
      id: 'strict-macros', format: 'json', stateStore: new FileHealthConnectorStateStore(join(root, 'macros.json')),
      content: JSON.stringify([{ domain: 'diet', sourceId: 'macro-1', observedAt: '2026-07-13T01:00:00Z', evidenceClass: 'reported', confidence: 1,
        payload: { macros: { caloriesKcal: 500, proteinG: 30, carbsG: 60, fatG: 12 }, micros: { fiberG: 8, sodiumMg: 500 } } }]),
      ingest: envelope => { envelopes.push(envelope); return {} as never },
    })

    await connector.sync({ now: '2026-07-13T02:00:00Z' })
    expect(envelopes[0].payload).toMatchObject({ caloriesKcal: 500, proteinG: 30, carbsG: 60, fatG: 12, micros: { fiberG: 8, sodiumMg: 500 } })
    expect(envelopes[0].payload).not.toHaveProperty('macros')
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
    expect(failedStatus.freshnessByDomain).toEqual({ diet: '2026-07-13T01:00:00Z' })
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
    const { FileHealthConnectorStateStore, createConnectorCursor } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const path = join(root, 'state.json')
    const connector = createStructuredImportConnector({
      id: 'empty-source', format: 'json', content: '[]', stateStore: new FileHealthConnectorStateStore(path), ingest: () => ({} as never),
    })

    await expect(connector.sync({ now: 'not-a-time' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ now: '2026-07-13T01:00:00+14:00' })).resolves.toMatchObject({ attemptedCount: 0 })
    await expect(connector.sync({ now: '2026-07-13T01:00:00+14:01' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ now: '2026-07-13T01:00:00+23:59' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ now: '2026-02-30T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_TIMESTAMP/)
    await expect(connector.sync({ cursor: '../bad', now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_CURSOR/)
    await expect(connector.sync({ cursor: 'stale', now: '2026-07-13T01:00:00Z' })).rejects.toThrow(/CONNECTOR_INVALID_CURSOR/)
    await expect(connector.sync({ cursor: createConnectorCursor('2026-07-14T00:00:00Z', 'future'), now: '2026-07-13T01:00:00Z' }))
      .rejects.toThrow(/CONNECTOR_CURSOR_CONFLICT/)
    await expect(connector.sync({ now: '2026-07-13T01:00:00Z' })).resolves.toMatchObject({ attemptedCount: 0, ingestedCount: 0 })
    await writeFile(path, '{"empty-source":{"cursor":"../../escape"}}', 'utf8')
    expect(await connector.status()).toMatchObject({ configured: true, health: 'unavailable', errorCode: 'CONNECTOR_STATE_CORRUPT' })
    await expect(connector.sync({ now: '2026-07-13T02:00:00Z' })).rejects.toThrow(/CONNECTOR_STATE_CORRUPT/)
  })

  it('reads legacy connector state compatibly and supplies new status defaults', async () => {
    const { FileHealthConnectorStateStore, createConnectorCursor } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const path = join(root, 'legacy-state.json')
    const cursor = createConnectorCursor('2026-07-12T00:00:00Z', 'legacy')
    await writeFile(path, JSON.stringify({ version: 1, connectors: { legacy: {
      health: 'healthy', lastAttemptAt: '2026-07-12T01:00:00Z', lastSuccessAt: '2026-07-12T01:00:00Z', cursor,
    } } }), 'utf8')
    const connector = createStructuredImportConnector({ id: 'legacy', format: 'json', content: '[]', stateStore: new FileHealthConnectorStateStore(path), ingest: () => ({} as never) })

    expect(await connector.status()).toMatchObject({
      configured: true, configurationState: 'configured', authorizationState: 'not_required', health: 'healthy', cursor,
      freshnessByDomain: {}, capabilities: { read: ['diet', 'fitness', 'sleep'], write: [] },
    })
    const forward = createConnectorCursor('2026-07-13T00:00:00Z', 'forward')
    await expect(connector.sync({ cursor: forward, now: '2026-07-13T01:00:00Z' })).resolves.toMatchObject({ cursor: forward })
    expect((await connector.status()).cursor).toBe(forward)
  })

  it('fails closed on impossible persisted freshness and attempt time combinations', async () => {
    const { FileHealthConnectorStateStore } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const { createStructuredImportConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors/structured-import')
    const cases: Array<[string, Record<string, unknown>, 'healthy' | 'unavailable']> = [
      ['future-freshness', { health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', freshnessByDomain: { diet: '2026-07-13T02:00:00Z' } }, 'unavailable'],
      ['future-success', { health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', lastSuccessAt: '2026-07-13T02:00:00Z' }, 'unavailable'],
      ['freshness-without-attempt', { health: 'healthy', freshnessByDomain: { diet: '2026-07-13T00:00:00Z' } }, 'unavailable'],
      ['success-without-attempt', { health: 'healthy', lastSuccessAt: '2026-07-13T00:00:00Z' }, 'unavailable'],
      ['equal-freshness', { health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', lastSuccessAt: '2026-07-13T01:00:00Z', freshnessByDomain: { diet: '2026-07-13T01:00:00Z' } }, 'healthy'],
      ['earlier-freshness', { health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', lastSuccessAt: '2026-07-13T00:30:00Z', freshnessByDomain: { diet: '2026-07-13T00:00:00Z' } }, 'healthy'],
      ['never-attempted', { health: 'unavailable' }, 'unavailable'],
    ]
    for (const [id, state, expectedHealth] of cases) {
      const path = join(root, `${id}.json`)
      await writeFile(path, JSON.stringify({ version: 1, connectors: { [id]: state } }), 'utf8')
      const connector = createStructuredImportConnector({ id, format: 'json', content: '[]', stateStore: new FileHealthConnectorStateStore(path), ingest: () => ({} as never) })
      const status = await connector.status()
      expect(status.health).toBe(expectedHealth)
      if (id !== 'never-attempted' && expectedHealth === 'unavailable') expect(status.errorCode).toBe('CONNECTOR_STATE_CORRUPT')
    }
  })

  it('keeps generic connector cursors opaque while validating declared timestamp cursors', async () => {
    const { FileHealthConnectorStateStore, createConnectorCursor, createManagedHealthConnector } = await import('../../packages/server/src/services/hermes/health-loop/connectors')
    const opaquePath = join(root, 'opaque-state.json')
    await writeFile(opaquePath, JSON.stringify({ version: 1, connectors: { opaque: {
      health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', cursor: 'vendor/page+7==',
    } } }), 'utf8')
    const sourceBase = {
      domains: ['diet'] as const, capabilities: { read: ['diet'] as const, write: [] as const },
      access: async () => ({ configurationState: 'configured' as const, authorizationState: 'not_required' as const }),
      load: async () => ({ envelopes: [] }),
    }
    const opaque = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(opaquePath), ingest: () => ({} as never), source: { id: 'opaque', ...sourceBase },
    })
    expect(await opaque.status()).toMatchObject({ health: 'healthy', cursor: 'vendor/page+7==' })

    const rfcOpaquePath = join(root, 'rfc-opaque-state.json')
    const rfcLookingToken = '2026-07-14T00:00:00Z'
    await writeFile(rfcOpaquePath, JSON.stringify({ version: 1, connectors: { 'rfc-opaque': {
      health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', cursor: rfcLookingToken,
    } } }), 'utf8')
    const rfcOpaque = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(rfcOpaquePath), ingest: () => ({} as never), source: { id: 'rfc-opaque', ...sourceBase },
    })
    expect(await rfcOpaque.status()).toMatchObject({ health: 'healthy', cursor: rfcLookingToken })

    const timestampPath = join(root, 'timestamp-state.json')
    await writeFile(timestampPath, JSON.stringify({ version: 1, connectors: { timestamp: {
      health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', cursor: createConnectorCursor('2026-07-13T02:00:00Z', 'future'),
    } } }), 'utf8')
    const timestamp = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(timestampPath), ingest: () => ({} as never),
      source: { id: 'timestamp', cursorKind: 'timestamp', ...sourceBase },
    })
    expect(await timestamp.status()).toMatchObject({ health: 'unavailable', errorCode: 'CONNECTOR_STATE_CORRUPT' })

    const malformedTimestampPath = join(root, 'malformed-timestamp-state.json')
    await writeFile(malformedTimestampPath, JSON.stringify({ version: 1, connectors: { 'malformed-timestamp': {
      health: 'healthy', cursor: 'vendor/page+7==',
    } } }), 'utf8')
    const malformedTimestamp = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(malformedTimestampPath), ingest: () => ({} as never),
      source: { id: 'malformed-timestamp', cursorKind: 'timestamp', ...sourceBase },
    })
    expect(await malformedTimestamp.status()).toMatchObject({ health: 'unavailable', errorCode: 'CONNECTOR_STATE_CORRUPT' })

    const validTimestampPath = join(root, 'valid-timestamp-state.json')
    const validTimestampCursor = createConnectorCursor('2026-07-13T00:00:00Z', 'valid')
    await writeFile(validTimestampPath, JSON.stringify({ version: 1, connectors: { 'valid-timestamp': {
      health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', cursor: validTimestampCursor,
    } } }), 'utf8')
    const validTimestamp = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(validTimestampPath), ingest: () => ({} as never),
      source: { id: 'valid-timestamp', cursorKind: 'timestamp', ...sourceBase },
    })
    expect(await validTimestamp.status()).toMatchObject({ health: 'healthy', cursor: validTimestampCursor })

    const rawTimestampPath = join(root, 'raw-timestamp-state.json')
    await writeFile(rawTimestampPath, JSON.stringify({ version: 1, connectors: { 'raw-timestamp': {
      health: 'healthy', lastAttemptAt: '2026-07-13T01:00:00Z', cursor: rfcLookingToken,
    } } }), 'utf8')
    const rawTimestamp = createManagedHealthConnector({
      stateStore: new FileHealthConnectorStateStore(rawTimestampPath), ingest: () => ({} as never),
      source: { id: 'raw-timestamp', cursorKind: 'timestamp', ...sourceBase },
    })
    expect(await rawTimestamp.status()).toMatchObject({ health: 'unavailable', errorCode: 'CONNECTOR_STATE_CORRUPT' })
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
