import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const observedAt = '2026-07-13T08:00:00.000Z'

describe('health artifact analysis', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-analysis-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it.each([
    ['measurement', ['waistCm'], { waistCm: 88 }, 'measurements', 'completed'],
    ['posture', ['angles'], { angles: { headForwardDeg: 8 } }, 'posture', 'completed'],
    ['skin', ['appearances'], { appearances: [{ type: 'redness', severity: 0.2 }] }, 'skin', 'completed'],
    ['diet', ['foods'], { foods: [{ name: 'rice', portionGrams: 180 }] }, 'diet', 'completed'],
    ['internal_health', ['markers'], { markers: [{ key: 'fasting_glucose', value: 5.2, unit: 'mmol/L', evidence: { page: 2, region: 'page:2/lab-row' } }] }, 'internal_health', 'pending_confirmation'],
  ] as const)('validates %s output and creates a canonical inferred envelope', async (purpose, requestedFields, payload, domain, status) => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'a'.repeat(64)}`
    const fields = Object.entries(payload).map(([field, value]) => ({
      field, value, ...(purpose === 'measurement' ? { unit: 'cm' } : purpose === 'posture' ? { unit: 'degree' } : {}),
      confidence: 0.86, evidence: { artifactId, ...(purpose === 'internal_health' ? { page: 2, region: 'page:2/lab-row' } : { region: 'subject' }) },
    }))
    const request = {
      schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose, sourceId: `${purpose}-1`, observedAt,
      artifactIds: [artifactId], selectedRegions: purpose === 'internal_health' ? ['page:2/lab-row'] : ['subject'], requestedFields: [...requestedFields],
    }
    const result = finalizeHealthAnalysis(request, {
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.86,
      captureQuality: { score: 0.95, reasons: [] }, fields,
    }, { processor: 'processor:test', locality: 'local' })

    expect(result.status).toBe(status)
    expect(result).toMatchObject({ schemaVersion: 'health-analysis-result/v1', purpose, modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.86 })
    expect(result.envelope).toMatchObject({ domain, sourceId: `${purpose}-1:model-1:parser-1`, evidenceClass: 'inferred', artifactIds: [artifactId] })
    const error = (() => { try { finalizeHealthAnalysis(request, { ...result, extra: true }, { processor: 'processor:test', locality: 'local' }); return null } catch (value) { return value } })()
    expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_OUTPUT' })
  })

  it('returns recapture only and never emits an inferred envelope for low capture quality', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'b'.repeat(64)}`
    const request = {
      schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'measurement-low', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'],
    }
    const result = finalizeHealthAnalysis(request, {
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.4,
      captureQuality: { score: 0.4, reasons: ['blur'] },
      fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 0.4, evidence: { artifactId, region: 'subject' } }],
    }, { processor: 'local:test', locality: 'local' })
    expect(result).toEqual({
      schemaVersion: 'health-analysis-result/v1', purpose: 'measurement', status: 'recapture_required', modelVersion: 'model-1', parserVersion: 'parser-1',
      overallConfidence: 0.4, captureQuality: { score: 0.4, reasons: ['blur'] }, fields: [], recaptureGuidance: ['Recapture with the image in sharp focus.'],
    })
    expect(result).not.toHaveProperty('envelope')
  })

  it('applies the purpose quality threshold and requires an actionable recapture reason', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'9'.repeat(64)}`
    const request = {
      schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'skin' as const, sourceId: 'skin-threshold', observedAt,
      artifactIds: [artifactId], selectedRegions: ['face'], requestedFields: ['appearances'],
    }
    const output = {
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'skin-1', parserVersion: 'vision-json-v1', overallConfidence: 0.72,
      captureQuality: { score: 0.72, reasons: ['blur'] },
      fields: [{ field: 'appearances', value: [{ type: 'redness', severity: 0.1 }], confidence: 0.72, evidence: { artifactId, region: 'face' } }],
    }
    expect(finalizeHealthAnalysis(request, output, { processor: 'local:test', locality: 'local' }).status).toBe('recapture_required')
    const noReason = (() => {
      try { finalizeHealthAnalysis(request, { ...output, captureQuality: { score: 0.72, reasons: [] } }, { processor: 'local:test', locality: 'local' }); return null }
      catch (error) { return error }
    })()
    expect(noReason).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_OUTPUT' })
  })

  it('binds canonical units and semantic types before low-quality or completed output can proceed', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'a'.repeat(64)}`
    const cases = [
      { purpose: 'measurement' as const, field: 'waistCm', value: 88, unit: 'cm' },
      { purpose: 'posture' as const, field: 'angles', value: { headForwardDeg: 8 }, unit: 'degree' },
      { purpose: 'skin' as const, field: 'distanceCm', value: 40, unit: 'cm' },
      { purpose: 'diet' as const, field: 'caloriesKcal', value: 520, unit: 'kcal' },
      { purpose: 'diet' as const, field: 'proteinG', value: 30, unit: 'g' },
      { purpose: 'diet' as const, field: 'waterMl', value: 350, unit: 'mL' },
    ]
    for (const [index, current] of cases.entries()) {
      const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: current.purpose, sourceId: `unit-${index}`, observedAt,
        artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: [current.field] }
      const output = { schemaVersion: 'health-analyzer-output/v1', modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.9,
        captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: current.field, value: current.value, unit: current.unit, confidence: 0.9, evidence: { artifactId, region: 'subject' } }] }
      expect(finalizeHealthAnalysis(request, output, { processor: 'local:test', locality: 'local' }).status).toBe('completed')
      for (const badUnit of [undefined, current.unit === 'kg' ? 'cm' : 'kg']) {
        const field = { ...output.fields[0], ...(badUnit === undefined ? {} : { unit: badUnit }) }
        if (badUnit === undefined) delete (field as { unit?: string }).unit
        const error = (() => { try { finalizeHealthAnalysis(request, { ...output, fields: [field] }, { processor: 'local:test', locality: 'local' }); return null } catch (value) { return value } })()
        expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_OUTPUT' })
      }
    }

    const mealRequest = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'diet' as const, sourceId: 'unitless', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['mealTime'] }
    const mealOutput = { schemaVersion: 'health-analyzer-output/v1', modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'mealTime', value: observedAt, unit: 'second', confidence: 0.9, evidence: { artifactId, region: 'subject' } }] }
    expect(() => finalizeHealthAnalysis(mealRequest, mealOutput, { processor: 'local:test', locality: 'local' }))
      .toThrowError('HEALTH_ANALYSIS_INVALID_OUTPUT')

    const lowRequest = { ...mealRequest, purpose: 'measurement' as const, sourceId: 'semantic-low', requestedFields: ['waistCm'] }
    const lowOutput = { ...mealOutput, captureQuality: { score: 0.4, reasons: ['blur'] },
      fields: [{ field: 'waistCm', value: '88', unit: 'cm', confidence: 0.4, evidence: { artifactId, region: 'subject' } }] }
    expect(() => finalizeHealthAnalysis(lowRequest, lowOutput, { processor: 'local:test', locality: 'local' }))
      .toThrowError('HEALTH_ANALYSIS_INVALID_OUTPUT')
  })

  it('fails closed on fields outside the request, bad evidence, invalid confidence, unknown keys, and hostile graphs', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'c'.repeat(64)}`
    const request = {
      schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'measurement-2', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'],
    }
    const base = {
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'model-1', parserVersion: 'parser-1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] },
      fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 0.9, evidence: { artifactId, region: 'subject' } }],
    }
    const hostile: Record<string, unknown> = { ...base }; hostile.fields = hostile
    const accessor = { ...base }; Object.defineProperty(accessor, 'fields', { enumerable: true, get: () => base.fields })
    const proxy = new Proxy({ ...base }, { ownKeys: () => { throw new Error(`secret ${hermesHome}`) } })
    const fieldsWithSecret = [...base.fields] as typeof base.fields & { hidden?: string }; fieldsWithSecret.hidden = 'secret'
    const candidates = [
      { ...base, fields: [{ ...base.fields[0], field: 'hipCm' }] },
      { ...base, fields: [{ ...base.fields[0], evidence: { artifactId: `artifact-${'d'.repeat(64)}`, region: 'subject' } }] },
      { ...base, fields: [{ ...base.fields[0], evidence: { artifactId, region: 'other' } }] },
      { ...base, overallConfidence: Number.NaN },
      { ...base, captureQuality: { score: 0.9, reasons: [], diagnosis: 'x' } }, { ...base, fields: fieldsWithSecret }, hostile, accessor, proxy,
    ]
    for (const candidate of candidates) {
      const error = (() => { try { finalizeHealthAnalysis(request, candidate, { processor: 'local:test', locality: 'local' }); return null } catch (value) { return value } })()
      expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_OUTPUT' })
      expect(String((error as Error).message)).not.toContain(hermesHome)
    }
  })

  it('rejects a calendar-invalid RFC3339 instant before a low-quality result can bypass Task3 validation', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const artifactId = `artifact-${'7'.repeat(64)}`
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'bad-time',
      observedAt: '2026-02-31T08:00:00Z', artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const output = { schemaVersion: 'health-analyzer-output/v1', modelVersion: 'measure-1', parserVersion: 'vision-json-v1', overallConfidence: 0.4,
      captureQuality: { score: 0.4, reasons: ['blur'] }, fields: [{ field: 'waistCm', value: 88, confidence: 0.4, evidence: { artifactId, region: 'subject' } }] }
    const error = (() => { try { finalizeHealthAnalysis(request, output, { processor: 'local:test', locality: 'local' }); return null } catch (value) { return value } })()
    expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_REQUEST' })
  })

  it('parses strict structured JSON, CSV, and pre-extracted report text through canonical Task3 validation', async () => {
    const { createStructuredHealthAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/structured')
    const artifactId = `artifact-${'e'.repeat(64)}`
    const analyzer = createStructuredHealthAnalyzer()
    const base = {
      schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', sourceId: 'structured-1', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'],
    }
    const json = await analyzer.analyze({ request: { ...base, purpose: 'measurement', requestedFields: ['waistCm'] }, format: 'json', content: JSON.stringify({
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'structured', parserVersion: 'structured-json-v1', overallConfidence: 1,
      captureQuality: { score: 1, reasons: [] }, fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 1, evidence: { artifactId, region: 'subject' } }],
    }) })
    expect(json.envelope?.payload).toMatchObject({ waistCm: 88 })

    const csv = await analyzer.analyze({ request: { ...base, sourceId: 'csv-1', purpose: 'measurement', requestedFields: ['waistCm'] }, format: 'csv',
      content: `field,value,unit,confidence,artifact_id,region,page\nwaistCm,88,cm,1,${artifactId},subject,\n` })
    expect(csv.envelope?.payload).toMatchObject({ waistCm: 88 })

    const report = await analyzer.analyze({ request: { ...base, sourceId: 'report-1', purpose: 'internal_health', selectedRegions: ['page:2/lab-row'], requestedFields: ['markers'] }, format: 'report_text',
      content: `marker\tfasting_glucose\t5.2\tmmol/L\t1\t${artifactId}\t2\tpage:2/lab-row` })
    expect(report.status).toBe('pending_confirmation')

    await expect(analyzer.analyze({ request: { ...base, purpose: 'measurement', requestedFields: ['waistCm'] }, format: 'json', content: `result: {"waistCm":88}` }))
      .rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_INPUT' })
  })

  it('rejects mixed report artifacts and preserves page and region evidence for one scoped document', async () => {
    const { createStructuredHealthAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/structured')
    const analyzer = createStructuredHealthAnalyzer()
    const first = `artifact-${'b'.repeat(64)}`; const second = `artifact-${'c'.repeat(64)}`
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'internal_health' as const, sourceId: 'report-evidence', observedAt,
      artifactIds: [first, second], selectedRegions: ['page:1/row-a', 'page:2/row-b'], requestedFields: ['markers'] }
    const row = (artifactId: string, page: number, region: string, key: string) => `marker\t${key}\t5.2\tmmol/L\t1\t${artifactId}\t${page}\t${region}`
    await expect(analyzer.analyze({ request, format: 'report_text', content: `${row(first, 1, 'page:1/row-a', 'glucose')}\n${row(second, 2, 'page:2/row-b', 'hba1c')}` }))
      .rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_INPUT' })

    const result = await analyzer.analyze({ request: { ...request, artifactIds: [first] }, format: 'report_text',
      content: `${row(first, 1, 'page:1/row-a', 'glucose')}\n${row(first, 2, 'page:2/row-b', 'hba1c')}` })
    expect(result.envelope?.payload).toMatchObject({ markers: [
      expect.objectContaining({ key: 'glucose', evidence: { page: 1, region: 'page:1/row-a' } }),
      expect.objectContaining({ key: 'hba1c', evidence: { page: 2, region: 'page:2/row-b' } }),
    ] })
  })

  it('emits a stable Task3 envelope whose exact replay is a no-op', async () => {
    const { finalizeHealthAnalysis } = await import('../../packages/server/src/services/hermes/health-loop/analysis')
    const { ingestHealthEnvelope } = await import('../../packages/server/src/services/hermes/health-loop/ingestion')
    const artifactId = `artifact-${'8'.repeat(64)}`
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'stable-analysis', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const result = finalizeHealthAnalysis(request, {
      schemaVersion: 'health-analyzer-output/v1', modelVersion: 'measure-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 0.9, evidence: { artifactId, region: 'subject' } }],
    }, { processor: 'local:test', locality: 'local' })
    const first = ingestHealthEnvelope(result.envelope!)
    const replay = ingestHealthEnvelope(result.envelope!)
    expect(replay.observations.map(item => item.id)).toEqual(first.observations.map(item => item.id))
    expect(replay.event.id).toBe(first.event.id)
  })

  it('defends structured inputs against UTF-8, size, rows, poison keys, getters, proxies, cycles, and non-finite values', async () => {
    const { createStructuredHealthAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/structured')
    const analyzer = createStructuredHealthAnalyzer({ maxInputBytes: 1024, maxRows: 4 })
    const artifactId = `artifact-${'f'.repeat(64)}`
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'hostile', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const poison = JSON.parse('{"schemaVersion":"health-analyzer-output/v1","__proto__":{},"modelVersion":"x","parserVersion":"x","overallConfidence":1,"captureQuality":{"score":1,"reasons":[]},"fields":[]}')
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get: () => 1 })
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('secret') } })
    for (const content of [poison, cycle, accessor, proxy, { value: Infinity }, 'x'.repeat(1025), Buffer.from([0xc3, 0x28])]) {
      await expect(analyzer.analyze({ request, format: 'json', content })).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_INPUT' })
    }
  })

  it('consumes exact remote consent before vault reads and dispatch, calls once, then denies replay', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'1'.repeat(64)}`
    const order: string[] = []
    const content = Buffer.from('png')
    const broker = { consume: vi.fn(async () => { order.push('consume'); return { consentId: 'consent-1', manifestDigest: 'a'.repeat(64), consumedAt: observedAt } }) }
    const artifactMetadataResolver = vi.fn(async () => { order.push('metadata'); return { id: artifactId, mediaType: 'image/png', sizeBytes: 3 } })
    const vault = { read: vi.fn(async () => { order.push('read'); return { artifact: { id: artifactId, mediaType: 'image/png', sizeBytes: 3, metadata: { secret: 'drop' }, relativePath: 'secret/path' }, content } }) }
    const client = { analyze: vi.fn(async (input: any) => {
      order.push('client')
      expect(input.artifacts).toEqual([{ artifactId, mediaType: 'image/png', content: Buffer.from('png') }])
      expect(input.artifacts[0].content).toBe(content)
      expect(JSON.stringify(input)).not.toMatch(/secret\/path|bearer|api_key/i)
      return JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
        captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 0.9, evidence: { artifactId, region: 'subject' } }] })
    }) }
    const resolver = vi.fn(async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote' as const, timeoutMs: 1_000 }))
    const analyzer = createAuxiliaryVisionAnalyzer({ resolver, client, vault: vault as any, consentBroker: broker as any, artifactMetadataResolver, maxResponseBytes: 8192 })
    const manifest = { artifactIds: [artifactId], processor: 'remote:test', purpose: 'measurement' as const, selectedRegions: ['subject'], requestedFields: ['waistCm'], retention: 'no_retention' as const }
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'remote-1', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'], manifest, consentToken: '0'.repeat(64) }
    await expect(analyzer.analyze(request)).resolves.toMatchObject({ status: 'completed' })
    expect(order).toEqual(['consume', 'metadata', 'read', 'client'])
    broker.consume.mockRejectedValueOnce(Object.assign(new Error('replayed token secret'), { code: 'HEALTH_CONSENT_REPLAYED' }))
    await expect(analyzer.analyze(request)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_CONSENT_DENIED' })
    expect(client.analyze).toHaveBeenCalledTimes(1)
  })

  it('never reads or calls the remote client on consent denial, while local providers need no consent', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'2'.repeat(64)}`
    const output = JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'appearances', value: [{ type: 'redness', severity: 0.1 }], confidence: 0.9, evidence: { artifactId, region: 'face' } }] })
    const vault = { read: vi.fn(async () => ({ artifact: { id: artifactId, mediaType: 'image/png', sizeBytes: 3 }, content: Buffer.from('png') })) }
    const artifactMetadataResolver = async () => ({ id: artifactId, mediaType: 'image/png', sizeBytes: 3 })
    const client = { analyze: vi.fn(async () => output) }
    const denied = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote', timeoutMs: 100 }), client,
      vault: vault as any, artifactMetadataResolver, consentBroker: { consume: vi.fn(async () => { throw new Error('db corrupt path C:\\secret') }) } as any })
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'skin' as const, sourceId: 'skin-1', observedAt,
      artifactIds: [artifactId], selectedRegions: ['face'], requestedFields: ['appearances'],
      manifest: { artifactIds: [artifactId], processor: 'remote:test', purpose: 'skin' as const, selectedRegions: ['face'], requestedFields: ['appearances'], retention: 'no_retention' as const }, consentToken: '0'.repeat(64) }
    await expect(denied.analyze(request)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_CONSENT_DENIED' })
    expect(vault.read).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled()

    const local = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'local:test', model: 'vision-1', locality: 'local', timeoutMs: 100 }), client, vault: vault as any, artifactMetadataResolver })
    const { manifest: _manifest, consentToken: _consentToken, ...localRequest } = request
    await expect(local.analyze(localRequest)).resolves.toMatchObject({ status: 'completed' })
    expect(client.analyze).toHaveBeenCalledTimes(1)

    for (const candidate of [
      { ...localRequest, manifest: undefined },
      { ...localRequest, consentToken: undefined },
      { ...localRequest, manifest: request.manifest },
      { ...localRequest, manifest: 'malicious-manifest' },
      { ...localRequest, consentToken: 'must-not-be-accepted-locally' },
      { ...localRequest, consentToken: { value: 'malicious-token' } },
      { ...localRequest, manifest: request.manifest, consentToken: 'must-not-be-accepted-locally' },
    ]) {
      await expect(local.analyze(candidate as any)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_REQUEST' })
    }
    expect(client.analyze).toHaveBeenCalledTimes(1)
  })

  it('requires both exact remote authorization fields before consent, vault access, or dispatch', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'5'.repeat(64)}`
    const consume = vi.fn(async () => ({ consentId: 'consent-1', manifestDigest: 'a'.repeat(64), consumedAt: observedAt }))
    const vault = { read: vi.fn(async () => { throw new Error('must not read') }) }
    const client = { analyze: vi.fn(async () => '{}') }
    const analyzer = createAuxiliaryVisionAnalyzer({
      resolver: async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote', timeoutMs: 100 }),
      consentBroker: { consume } as any, vault: vault as any, client,
    })
    const base = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'remote-required', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const manifest = { artifactIds: [artifactId], processor: 'remote:test', purpose: 'measurement' as const, selectedRegions: ['subject'], requestedFields: ['waistCm'], retention: 'session' as const }
    for (const candidate of [{ ...base, consentToken: '0'.repeat(64) }, { ...base, manifest }, { ...base, manifest, consentToken: 'short-token' }]) {
      await expect(analyzer.analyze(candidate as any)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_REQUEST' })
    }
    expect(consume).not.toHaveBeenCalled(); expect(vault.read).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled()
  })

  it('fails closed on hostile top-level request shape and non-dense request arrays', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'6'.repeat(64)}`
    const resolver = vi.fn(async () => ({ provider: 'local:test', model: 'vision-1', locality: 'local' as const, timeoutMs: 100 }))
    const vault = { read: vi.fn() }; const client = { analyze: vi.fn() }
    const analyzer = createAuxiliaryVisionAnalyzer({ resolver, vault: vault as any, client: client as any })
    const base = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'hostile-request', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const hidden = { ...base }; Object.defineProperty(hidden, 'hidden', { value: 'secret', enumerable: false })
    const accessor = { ...base }; Object.defineProperty(accessor, 'manifest', { enumerable: true, get: () => ({}) })
    const sparse = { ...base, artifactIds: Array(2) }; sparse.artifactIds[0] = artifactId
    const customArray = [...base.requestedFields] as string[] & { secret?: string }; customArray.secret = 'secret'
    const proxy = new Proxy({ ...base }, { ownKeys: () => { throw new Error(`secret ${hermesHome}`) } })
    for (const candidate of [{ ...base, callbackUrl: 'https://attacker.test' }, hidden, accessor, sparse, { ...base, requestedFields: customArray }, proxy]) {
      const error = await analyzer.analyze(candidate as any).catch(value => value)
      expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_REQUEST' })
      expect(error.message).not.toContain(hermesHome)
    }
    expect(resolver).not.toHaveBeenCalled(); expect(vault.read).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled()
  })

  it('uses the real one-time broker for approved camelCase fields and every Task5 retention', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const { createHealthConsentBroker, HEALTH_PROCESSING_RETENTIONS } = await import('../../packages/server/src/services/hermes/health-loop/consent')
    const vault = createHealthArtifactVault({ accessController: { secureDirectory: async () => undefined, secureFile: async () => undefined } })
    const artifact = await vault.store({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), declaredMediaType: 'image/png',
      source: 'health-analysis-test', sourceId: 'real-consent', metadata: {},
    })
    const broker = createHealthConsentBroker({ allowedProcessors: ['remote:test'] })
    const cases = [
      { purpose: 'measurement' as const, field: 'waistCm', value: 88, retention: HEALTH_PROCESSING_RETENTIONS[0] },
      { purpose: 'skin' as const, field: 'lightingProfile', value: 'standardized_neutral', retention: HEALTH_PROCESSING_RETENTIONS[1] },
      { purpose: 'diet' as const, field: 'mealTime', value: observedAt, retention: HEALTH_PROCESSING_RETENTIONS[2] },
      { purpose: 'internal_health' as const, field: 'reportDate', value: '2026-07-13', retention: HEALTH_PROCESSING_RETENTIONS[0] },
    ]
    const client = { analyze: vi.fn(async (input: any) => {
      const current = cases.find(item => item.field === input.requestedFields[0])!
      return JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
        captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: current.field, value: current.value,
          ...(current.field === 'waistCm' ? { unit: 'cm' } : {}), confidence: 0.9, evidence: { artifactId: artifact.id, region: 'subject' } }] })
    }) }
    const analyzer = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote', timeoutMs: 1000 }), client, vault, consentBroker: broker })
    for (const [index, current] of cases.entries()) {
      const manifest = { artifactIds: [artifact.id], processor: 'remote:test', purpose: current.purpose, selectedRegions: ['subject'], requestedFields: [current.field], retention: current.retention }
      const grant = await broker.issue(manifest)
      const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: current.purpose, sourceId: `real-consent-${index}`, observedAt,
        artifactIds: [artifact.id], selectedRegions: ['subject'], requestedFields: [current.field], manifest, consentToken: grant.token }
      await expect(analyzer.analyze(request)).resolves.toMatchObject({ status: current.purpose === 'internal_health' ? 'pending_confirmation' : 'completed' })
    }
    expect(client.analyze).toHaveBeenCalledTimes(4)
  })

  it('rejects changed remote scope and secret-shaped resolver output before artifact access', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'4'.repeat(64)}`
    const vault = { read: vi.fn(async () => { throw new Error('must not read') }) }
    const client = { analyze: vi.fn(async () => '{}') }
    const consume = vi.fn(async () => ({ consentId: 'consent-1', manifestDigest: 'a'.repeat(64), consumedAt: observedAt }))
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'scope-1', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'], consentToken: '0'.repeat(64),
      manifest: { artifactIds: [artifactId], processor: 'remote:other', purpose: 'measurement' as const, selectedRegions: ['subject'], requestedFields: ['waistCm'], retention: 'no_retention' as const } }
    const analyzer = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote', timeoutMs: 100 }), client, vault: vault as any,
      consentBroker: { consume } as any })
    await expect(analyzer.analyze(request)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_CONSENT_DENIED' })
    expect(consume).not.toHaveBeenCalled(); expect(vault.read).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled()

    const unsafe = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'local:test', model: 'vision-1', locality: 'local', timeoutMs: 100, apiKey: 'secret' } as any),
      client, vault: vault as any })
    const { manifest: _manifest, ...unsafeRequest } = request
    await expect(unsafe.analyze(unsafeRequest)).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_PROCESSOR_FAILED' })
    expect(vault.read).not.toHaveBeenCalled(); expect(client.analyze).not.toHaveBeenCalled()
  })

  it('enforces timeout, response size, strict JSON object framing, and version/evidence validation without leaking provider prose', async () => {
    const { createAuxiliaryVisionAnalyzer } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const artifactId = `artifact-${'3'.repeat(64)}`
    const request = { schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const, sourceId: 'strict-1', observedAt,
      artifactIds: [artifactId], selectedRegions: ['subject'], requestedFields: ['waistCm'] }
    const vault = { read: async () => ({ artifact: { id: artifactId, mediaType: 'image/png', sizeBytes: 3 }, content: Buffer.from('png') }) }
    const run = async (response: string | (() => Promise<string>), maxResponseBytes = 1024) => {
      const client = { analyze: typeof response === 'function' ? response : async () => response }
      return createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'local:test', model: 'vision-1', locality: 'local', timeoutMs: 10 }), client, vault: vault as any,
        artifactMetadataResolver: async () => ({ id: artifactId, mediaType: 'image/png', sizeBytes: 3 }), maxResponseBytes }).analyze(request)
    }
    for (const response of ['```json\n{}\n```', '{} trailing', '{}{}', 'x'.repeat(1025), JSON.stringify({ schemaVersion: 'wrong' }),
      JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'wrong', parserVersion: 'vision-json-v1', overallConfidence: 1, captureQuality: { score: 1, reasons: [] }, fields: [] }),
      JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'vision-1', parserVersion: 'wrong', overallConfidence: 1, captureQuality: { score: 1, reasons: [] }, fields: [] })]) {
      const error = await run(response).catch(value => value)
      expect(error).toMatchObject({ code: 'HEALTH_ANALYSIS_INVALID_OUTPUT' })
      expect(error.message).not.toContain(response)
    }
    await expect(run(() => new Promise(resolve => setTimeout(() => resolve('{}'), 100)))).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_TIMEOUT' })
  })

  it('preflights count, per-artifact, and aggregate budgets before reads and rechecks actual bytes without copying', async () => {
    const { createAuxiliaryVisionAnalyzer, HEALTH_VISION_ARTIFACT_LIMITS } = await import('../../packages/server/src/services/hermes/health-loop/analyzers/auxiliary-vision')
    const ids = Array.from({ length: 9 }, (_, index) => `artifact-${index.toString(16).repeat(64)}`)
    const request = (artifactIds: string[]) => ({ schemaVersion: 'health-analysis-request/v1' as const, profile: 'default', purpose: 'measurement' as const,
      sourceId: `budget-${artifactIds.length}`, observedAt, artifactIds, selectedRegions: ['subject'], requestedFields: ['waistCm'] })
    const response = (artifactId: string) => JSON.stringify({ schemaVersion: 'health-analyzer-output/v1', modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] }, fields: [{ field: 'waistCm', value: 88, unit: 'cm', confidence: 0.9, evidence: { artifactId, region: 'subject' } }] })
    const create = (sizes: Map<string, number>, contents = new Map<string, Buffer>()) => {
      const read = vi.fn(async (artifactId: string) => ({ artifact: { id: artifactId, mediaType: 'image/png', sizeBytes: sizes.get(artifactId)! },
        content: contents.get(artifactId) ?? Buffer.alloc(sizes.get(artifactId)!) }))
      const client = { analyze: vi.fn(async (input: any) => response(input.artifacts[0].artifactId)) }
      const artifactMetadataResolver = vi.fn(async (artifactId: string) => sizes.has(artifactId)
        ? { id: artifactId, mediaType: 'image/png', sizeBytes: sizes.get(artifactId)! } : null)
      const analyzer = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'local:test', model: 'vision-1', locality: 'local', timeoutMs: 1000 }),
        client, vault: { read } as any, artifactMetadataResolver })
      return { analyzer, read, client, artifactMetadataResolver }
    }

    const overCount = create(new Map(ids.map(id => [id, 1])))
    await expect(overCount.analyzer.analyze(request(ids))).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_ARTIFACT_DENIED' })
    expect(overCount.read).not.toHaveBeenCalled(); expect(overCount.client.analyze).not.toHaveBeenCalled()

    const perId = ids[0]; const overPer = create(new Map([[perId, HEALTH_VISION_ARTIFACT_LIMITS.maxArtifactBytes + 1]]))
    await expect(overPer.analyzer.analyze(request([perId]))).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_ARTIFACT_DENIED' })
    expect(overPer.read).not.toHaveBeenCalled(); expect(overPer.client.analyze).not.toHaveBeenCalled()

    const remoteConsume = vi.fn(async () => ({ consentId: 'consent-budget', manifestDigest: 'a'.repeat(64), consumedAt: observedAt }))
    const remote = createAuxiliaryVisionAnalyzer({ resolver: async () => ({ provider: 'remote:test', model: 'vision-1', locality: 'remote', timeoutMs: 1000 }),
      client: overPer.client, vault: { read: overPer.read } as any, consentBroker: { consume: remoteConsume } as any,
      artifactMetadataResolver: overPer.artifactMetadataResolver })
    const remoteManifest = { artifactIds: [perId], processor: 'remote:test', purpose: 'measurement' as const, selectedRegions: ['subject'], requestedFields: ['waistCm'], retention: 'no_retention' as const }
    await expect(remote.analyze({ ...request([perId]), manifest: remoteManifest, consentToken: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_ARTIFACT_DENIED' })
    expect(remoteConsume).toHaveBeenCalledTimes(1); expect(overPer.read).not.toHaveBeenCalled(); expect(overPer.client.analyze).not.toHaveBeenCalled()

    const totalIds = ids.slice(0, 3); const overTotal = create(new Map(totalIds.map(id => [id, 23 * 1024 * 1024])))
    await expect(overTotal.analyzer.analyze(request(totalIds))).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_ARTIFACT_DENIED' })
    expect(overTotal.read).not.toHaveBeenCalled(); expect(overTotal.client.analyze).not.toHaveBeenCalled()

    const actual = Buffer.from('four'); const lied = create(new Map([[perId, 3]]), new Map([[perId, actual]]))
    await expect(lied.analyzer.analyze(request([perId]))).rejects.toMatchObject({ code: 'HEALTH_ANALYSIS_ARTIFACT_DENIED' })
    expect(lied.read).toHaveBeenCalledTimes(1); expect(lied.client.analyze).not.toHaveBeenCalled()

    const original = Buffer.from('png'); const exact = create(new Map([[perId, original.byteLength]]), new Map([[perId, original]]))
    exact.client.analyze.mockImplementationOnce(async (input: any) => {
      expect(input.artifacts[0].content).toBe(original)
      return response(perId)
    })
    await expect(exact.analyzer.analyze(request([perId]))).resolves.toMatchObject({ status: 'completed' })
    expect(exact.client.analyze).toHaveBeenCalledTimes(1)
  })
})
