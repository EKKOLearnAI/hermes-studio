import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric'
import { createHealthShadowExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/shadow'
import { createHealthPlanExecutorAdapter, type HealthPlanRepository } from '../../packages/server/src/services/hermes/health-loop/executors/plan'
import { createHealthAnalysisExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/analysis'
import { createHealthWeixinExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/weixin'
import { createHealthSourceExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/source'
import { createConfiguredHealthFabricExecutorAdapters } from '../../packages/server/src/services/hermes/health-loop/executors/configuration'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const canonicalArtifactId = `artifact-${'a'.repeat(64)}`
const secondCanonicalArtifactId = `artifact-${'b'.repeat(64)}`
const canonicalObservedAt = '2026-07-14T01:00:00Z'

const finalizedResult = (status: 'completed' | 'recapture_required' = 'recapture_required') => ({
  schemaVersion: 'health-analysis-result/v1' as const, purpose: 'skin' as const, status,
  modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
  captureQuality: { score: status === 'completed' ? 0.9 : 0.4, reasons: status === 'completed' ? [] : ['blur'] },
  fields: [], ...(status === 'recapture_required' ? { recaptureGuidance: ['recapture'] } : {}),
})

function canonicalCompletedResult(purpose: 'measurement' | 'posture' | 'skin' | 'diet' | 'internal_health'):
Record<string, unknown> {
  const evidence = { artifactId: canonicalArtifactId, region: purpose === 'internal_health' ? 'page:2/lab' : 'front' }
  let fields: Array<Record<string, unknown>>
  let payload: Record<string, unknown>
  if (purpose === 'measurement') {
    fields = [{ field: 'captureConditions', value: { lightingProfile: 'even' }, confidence: 0.9, evidence }]
    payload = { captureConditions: { lightingProfile: 'even' }, modelVersion: 'vision-1', modelConfidence: 0.9 }
  } else if (purpose === 'posture') {
    fields = [{ field: 'angles', value: { headForwardDeg: 8 }, unit: 'degree', confidence: 0.9, evidence }]
    payload = { angles: { headForwardDeg: 8 }, modelVersion: 'vision-1', modelConfidence: 0.9 }
  } else if (purpose === 'skin') {
    fields = [{ field: 'appearances', value: [{ type: 'redness', severity: 0.4 }], confidence: 0.9, evidence }]
    payload = { appearances: [{ type: 'redness', severity: 0.4 }], captureQuality: 0.9 }
  } else if (purpose === 'diet') {
    fields = [{ field: 'foods', value: [{ name: 'rice', portionGrams: 180 }], confidence: 0.9, evidence }]
    payload = { foods: [{ name: 'rice', portionGrams: 180 }], parserConfidence: 0.9 }
  } else {
    fields = [{ field: 'markers', value: [{ key: 'fasting_glucose', value: 5.2, unit: 'mmol/L',
      evidence: { page: 2, region: 'page:2/lab' } }], confidence: 0.9, evidence }]
    payload = { markers: [{ key: 'fasting_glucose', value: 5.2, unit: 'mmol/L',
      evidence: { page: 2, region: 'page:2/lab' } }] }
  }
  return {
    schemaVersion: 'health-analysis-result/v1', purpose,
    status: purpose === 'internal_health' ? 'pending_confirmation' : 'completed',
    modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
    captureQuality: { score: 0.9, reasons: [] }, fields,
    envelope: { domain: purpose === 'measurement' ? 'measurements' : purpose, source: 'analysis.local',
      sourceId: 'analysis-source', observedAt: canonicalObservedAt, evidenceClass: 'inferred', confidence: 0.9,
      payload, artifactIds: [canonicalArtifactId], parserVersion: 'vision-json-v1' },
  }
}

function mutateEnvelopeResult(purpose: Parameters<typeof canonicalCompletedResult>[0],
  mutate: (envelope: Record<string, unknown>) => void): Record<string, unknown> {
  const result = canonicalCompletedResult(purpose)
  mutate(result.envelope as Record<string, unknown>)
  return result
}

function analysisWriter(record: { analysisId: string; status: 'succeeded' | 'needs_review' | 'failed'; observationIds: string[] }) {
  const stored = new Map<string, Record<string, unknown>>()
  return { lookup: vi.fn(async (token: string, material: string) => {
    const value = stored.get(token)
    return value?.materialDigest === material ? value as never : null
  }), write: vi.fn(async (request: { executionToken: string; materialDigest: string;
    artifactId: string; manifestDigest: string; processorId: string | null; reservationId: string | null;
    requestedAt: string; processorReceiptId: string | null }) => {
    const value = { ...record, executionToken: request.executionToken,
      materialDigest: request.materialDigest, artifactId: request.artifactId, manifestDigest: request.manifestDigest,
      processorId: request.processorId, reservationId: request.reservationId, requestedAt: request.requestedAt,
      processorReceiptId: request.processorReceiptId,
      verificationStatus: request.processorId && request.processorReceiptId ? 'verified' as const : request.processorId
        ? 'unverifiable' as const : 'verified' as const }
    stored.set(request.executionToken, value)
    return value
  }) }
}

function context(capabilityId: string, input: Record<string, unknown>, extra: Partial<FabricExecutionContext> = {}): FabricExecutionContext {
  return {
    intentId: 'intent-1', workflowId: 'workflow-1', stepId: 'step-1', executorId: 'health-shadow',
    executorType: 'connector', capabilityId, capabilityVersion: 1, contractDigest: digest(capabilityId),
    policyEvaluationToken: 'policy', executionToken: 'execution-1', input,
    target: { kind: 'health_recipient', recipient: 'configured-self' },
    now: '2026-07-14T01:00:00.000Z', ...extra,
  }
}

describe('health Action Fabric executors', () => {
  it('proves shadow execution is deterministic and invokes no live dependency', async () => {
    const adapter = createHealthShadowExecutorAdapter()
    const ctx = context('health.reminder.send', {
      schemaVersion: 2, actionId: 'action-1', recipient: 'configured-self', messageCode: 'eat',
    })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: {
      schemaVersion: 1, deliveryId: expect.stringMatching(/^shadow-/), providerMessageId: null, status: 'shadowed',
    } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
    expect(await adapter.interrupt(ctx)).toMatchObject({ outcome: 'interrupted' })
    expect(await adapter.compensate(ctx)).toMatchObject({ outcome: 'compensated' })
  })

  it('never invents a provider receipt for a remote v2 shadow analysis', async () => {
    const adapter = createHealthShadowExecutorAdapter()
    const ctx = context('health.artifact.analyze.remote', {
      schemaVersion: 1, artifactId: 'artifact-1', manifestDigest: digest('artifact'),
      requestedAt: canonicalObservedAt, processorId: 'processor-1', consentId: 'consent-1',
    }, { capabilityVersion: 2, executionToken: 'remote-shadow-v2', target: {
      kind: 'health_remote_artifact', artifactId: 'artifact-1', manifestDigest: digest('artifact'), processorId: 'processor-1',
    } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })

    expect(executed).toMatchObject({ outcome: 'succeeded', output: {
      artifactId: 'artifact-1', status: 'needs_review', processorReceiptId: null,
      verificationStatus: 'unverifiable', consentId: 'consent-1',
    } })
    expect(JSON.stringify(executed.output)).not.toContain('shadow-receipt')
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
  })

  it('applies plan changes with CAS and refuses compensation after an intervening edit', async () => {
    let current = { planId: 'plan-1', version: 3, digest: digest('v3') }
    const repository: HealthPlanRepository = {
      read: vi.fn(async () => ({ ...current })),
      adjust: vi.fn(async request => {
        if (current.version !== request.expectedVersion || current.digest !== request.expectedDigest) return null
        const previous = current
        current = { planId: current.planId, version: current.version + 1, digest: digest('v4') }
        return { previous, current: { ...current } }
      }),
      restore: vi.fn(async request => {
        if (current.version !== request.expectedCurrentVersion || current.digest !== request.expectedCurrentDigest) return null
        current = { planId: current.planId, version: request.restoreVersion, digest: request.restoreDigest }
        return { ...current }
      }),
    }
    const adapter = createHealthPlanExecutorAdapter({ repository })
    const ctx = context('health.plan.adjust', {
      schemaVersion: 1, planId: 'plan-1', expectedVersion: 3,
      operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'recovery',
    }, { executorId: 'health-plan', executorType: 'internal', target: { kind: 'health_plan', planId: 'plan-1' } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: {
      planId: 'plan-1', previousVersion: 3, newVersion: 4, previousDigest: digest('v3'), planDigest: digest('v4'),
    } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
    current = { planId: 'plan-1', version: 5, digest: digest('intervening') }
    expect(await adapter.compensate({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'failed', errorCode: 'HEALTH_PLAN_COMPENSATION_CONFLICT' })
  })

  it('restores a plan only at the expected current version and verifies the restored digest', async () => {
    let current = { planId: 'plan-1', version: 4, digest: digest('v4') }
    const repository: HealthPlanRepository = {
      read: async () => ({ ...current }),
      adjust: async () => null,
      restore: async request => {
        if (request.expectedCurrentVersion !== current.version || request.expectedCurrentDigest !== current.digest) return null
        current = { planId: request.planId, version: request.restoreVersion, digest: request.restoreDigest }
        return { ...current }
      },
    }
    const adapter = createHealthPlanExecutorAdapter({ repository })
    const ctx = context('health.plan.restore', { schemaVersion: 1, planId: 'plan-1', expectedCurrentVersion: 4,
      restoreVersion: 3, restoreDigest: digest('v3') },
    { executorId: 'health-plan', executorType: 'internal', target: { kind: 'health_plan', planId: 'plan-1' } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: {
      restoredVersion: 3, planDigest: digest('v3'), status: 'restored',
    } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
    expect(await adapter.interrupt(ctx)).toMatchObject({ outcome: 'unsupported' })
  })

  it('successfully compensates an adjustment only while its exact result is current', async () => {
    let current = { planId: 'plan-1', version: 3, digest: digest('v3') }
    const repository: HealthPlanRepository = {
      read: async () => ({ ...current }),
      adjust: async request => {
        const previous = { ...current }; current = { planId: request.planId, version: 4, digest: digest('v4') }
        return { previous, current: { ...current } }
      },
      restore: async request => {
        if (current.version !== request.expectedCurrentVersion || current.digest !== request.expectedCurrentDigest) return null
        current = { planId: request.planId, version: request.restoreVersion, digest: request.restoreDigest }
        return { ...current }
      },
    }
    const adapter = createHealthPlanExecutorAdapter({ repository })
    const ctx = context('health.plan.adjust', { schemaVersion: 1, planId: 'plan-1', expectedVersion: 3,
      operation: 'review_energy_deficit', reasonCode: 'deficit' },
    { executorId: 'health-plan', executorType: 'internal', target: { kind: 'health_plan', planId: 'plan-1' } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(await adapter.compensate({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'compensated' })
    expect(current).toEqual({ planId: 'plan-1', version: 3, digest: digest('v3') })
  })

  it('consumes exact remote consent once before analysis and persists receipt identity', async () => {
    const consume = vi.fn(async () => ({ consentId: 'consent-1', consumedAt: '2026-07-14T01:00:00.000Z', authorization: {} as never }))
    const analyze = vi.fn(async () => ({ result: finalizedResult(), providerReceiptId: 'receipt-1' }))
    const adapter = createHealthAnalysisExecutorAdapter({
      locality: 'remote', consentConsumer: { consume }, analyzer: { analyze },
      resultWriter: analysisWriter({ analysisId: 'analysis-1', status: 'succeeded', observationIds: ['observation-1'] }),
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
    })
    const ctx = context('health.artifact.analyze.remote', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z', processorId: 'processor-1', consentId: 'consent-1' },
    { executorId: 'health-remote-analysis', target: { kind: 'health_remote_artifact', artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), processorId: 'processor-1' } })
    const prepared = await adapter.prepare(ctx)
    const result = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ consentId: 'consent-1', artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), processorId: 'processor-1' }))
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ outcome: 'succeeded', output: { consentId: 'consent-1', processorReceiptId: 'receipt-1' } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: result.output }))
      .toMatchObject({ outcome: 'verified', output: { processorReceiptId: 'receipt-1' } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output,
      executionOutput: { ...result.output, observationIds: ['tampered-observation'] } }))
      .toMatchObject({ outcome: 'unknown', errorCode: 'HEALTH_ANALYSIS_VERIFICATION_UNAVAILABLE' })
    await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('keeps local analysis local and never consumes remote consent', async () => {
    const consume = vi.fn()
    const analyze = vi.fn(async () => ({ result: finalizedResult('recapture_required') }))
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local', analyzer: { analyze },
      resultWriter: analysisWriter({ analysisId: 'analysis-local', status: 'needs_review', observationIds: [] }),
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      consentConsumer: { consume } })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' },
    { executorId: 'health-local-analysis', executorType: 'internal', target: { kind: 'health_artifact', artifactId: 'artifact-1', manifestDigest: digest('artifact') } })
    const prepared = await adapter.prepare(ctx)
    expect((await adapter.execute({ ...ctx, preparedOutput: prepared.output })).outcome).toBe('succeeded')
    expect(consume).not.toHaveBeenCalled()
    expect(analyze.mock.calls[0][0]).not.toHaveProperty('processorId')
  })

  it('treats a durable failed source result as failure and verifies the complete snapshot', async () => {
    const failed = { executionToken: 'execution-1', materialDigest: '', connectorId: 's400',
      requestedAt: canonicalObservedAt, cursor: null, syncId: 'sync-failed', status: 'failed' as const, recordIds: [] }
    let stored: typeof failed | null = null
    const service = { lookup: vi.fn(async () => stored), write: vi.fn(async (request: { materialDigest: string }) => {
      stored = { ...failed, materialDigest: request.materialDigest }; return stored
    }) }
    const adapter = createHealthSourceExecutorAdapter(service)
    const ctx = context('health.source.sync', { schemaVersion: 1, connectorId: 's400', requestedAt: canonicalObservedAt },
      { executorId: 'health-source', target: { kind: 'health_connector', connectorId: 's400' } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_SOURCE_SYNC_FAILED',
      output: { status: 'failed', syncId: 'sync-failed' } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'mismatch', errorCode: 'HEALTH_SOURCE_SYNC_FAILED' })
  })

  it.each([
    ['extra provider output', () => ({ ...finalizedResult(), rawProviderOutput: 'secret-provider-payload' })],
    ['accessor', () => Object.defineProperty({ ...finalizedResult() }, 'rawProviderOutput', {
      enumerable: true, get: () => 'secret-provider-payload',
    })],
    ['symbol key', () => Object.defineProperty({ ...finalizedResult() }, Symbol('provider-secret'), {
      enumerable: true, value: 'secret-provider-payload',
    })],
    ['nested secret-shaped key', () => ({ ...finalizedResult(), fields: [{ field: 'appearances',
      value: [{ apiKey: 'secret-provider-payload' }], confidence: 0.9,
      evidence: { artifactId: `artifact-${'a'.repeat(64)}` } }] })],
    ['extra nested result key', () => ({ ...finalizedResult(), fields: [{ field: 'appearances',
      value: [{ type: 'rash', severity: 'low', rawConfidence: 0.9 }], confidence: 0.9,
      evidence: { artifactId: `artifact-${'a'.repeat(64)}` } }] })],
    ['proxy', () => new Proxy({ ...finalizedResult() }, {})],
    ['non-plain object', () => Object.assign(Object.create(null), finalizedResult())],
    ['cycle', () => { const value = { ...finalizedResult(), cycle: null as unknown }; value.cycle = value; return value }],
    ['oversize graph', () => ({ ...finalizedResult(), fields: [{ raw: 'x'.repeat(600_000) }] })],
  ])('rejects unsafe analyzer result form %s before the durable writer', async (_name, unsafeResult) => {
    const writer = analysisWriter({ analysisId: 'analysis-unsafe', status: 'succeeded', observationIds: [] })
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => ({ result: unsafeResult() as never }) }, resultWriter: writer })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' },
    { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)

    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_RESULT_INVALID' })
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('rejects analyzer result accessors without invoking their getters', async () => {
    let reads = 0
    const unsafe = Object.defineProperty({ ...finalizedResult() }, 'rawProviderOutput', {
      enumerable: true, get: () => { reads += 1; return 'secret-provider-payload' },
    })
    const writer = analysisWriter({ analysisId: 'analysis-accessor', status: 'succeeded', observationIds: [] })
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => ({ result: unsafe as never }) }, resultWriter: writer })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' },
    { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)

    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_RESULT_INVALID' })
    expect(reads).toBe(0)
    expect(writer.write).not.toHaveBeenCalled()
  })

  it.each([
    ['skin rawOutput', () => mutateEnvelopeResult('skin', envelope => {
      Object.assign(envelope.payload as Record<string, unknown>, { rawOutput: 'provider-payload' })
    })],
    ['skin rawResponse', () => mutateEnvelopeResult('skin', envelope => {
      const appearances = (envelope.payload as Record<string, unknown>).appearances as Array<Record<string, unknown>>
      appearances[0].rawResponse = 'provider-payload'
    })],
    ['noncanonical timezone', () => mutateEnvelopeResult('skin', envelope => {
      envelope.observedAt = '2026-07-14T09:00:00+08:00'
    })],
    ['different canonical timestamp', () => mutateEnvelopeResult('skin', envelope => {
      envelope.observedAt = '2026-07-14T01:01:00Z'
    })],
    ['different locality source', () => mutateEnvelopeResult('skin', envelope => {
      envelope.source = 'analysis.remote'
    })],
    ['duplicate artifact IDs', () => mutateEnvelopeResult('skin', envelope => {
      envelope.artifactIds = [canonicalArtifactId, canonicalArtifactId]
    })],
    ['unsorted artifact IDs', () => mutateEnvelopeResult('skin', envelope => {
      envelope.artifactIds = [secondCanonicalArtifactId, canonicalArtifactId]
    })],
    ['measurement nested unknown', () => mutateEnvelopeResult('measurement', envelope => {
      const payload = envelope.payload as Record<string, Record<string, unknown>>
      payload.captureConditions.unexpected = true
    })],
    ['posture nested unknown', () => mutateEnvelopeResult('posture', envelope => {
      const payload = envelope.payload as Record<string, Record<string, unknown>>
      payload.angles.unexpected = true
    })],
    ['diet nested unknown', () => mutateEnvelopeResult('diet', envelope => {
      const foods = (envelope.payload as Record<string, unknown>).foods as Array<Record<string, unknown>>
      foods[0].unexpected = true
    })],
    ['internal nested unknown', () => mutateEnvelopeResult('internal_health', envelope => {
      const markers = (envelope.payload as Record<string, unknown>).markers as Array<Record<string, unknown>>
      markers[0].unexpected = true
    })],
    ['payload differs from validated fields', () => mutateEnvelopeResult('skin', envelope => {
      const appearances = (envelope.payload as Record<string, unknown>).appearances as Array<Record<string, unknown>>
      appearances[0].severity = 0.5
    })],
    ['field evidence differs from execution artifact', () => {
      const result = canonicalCompletedResult('skin')
      const fields = result.fields as Array<Record<string, unknown>>
      fields[0].evidence = { artifactId: secondCanonicalArtifactId, region: 'front' }
      return result
    }],
  ])('rejects noncanonical or unbound envelope form %s before the durable writer', async (_name, result) => {
    const writer = analysisWriter({ analysisId: 'analysis-envelope', status: 'succeeded', observationIds: [] })
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      artifactResolver: { resolve: async () => ({ artifactId: canonicalArtifactId, manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => ({ result: result() as never }) }, resultWriter: writer })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: canonicalArtifactId,
      manifestDigest: digest('artifact'), requestedAt: canonicalObservedAt },
    { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)

    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_RESULT_INVALID' })
    expect(writer.write).not.toHaveBeenCalled()
  })

  it.each(['measurement', 'posture', 'skin', 'diet', 'internal_health'] as const)(
    'persists a canonical %s envelope reconstructed from validated fields', async purpose => {
      const writer = analysisWriter({ analysisId: `analysis-${purpose}`, status: 'succeeded', observationIds: [] })
      const result = canonicalCompletedResult(purpose)
      const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
        artifactResolver: { resolve: async () => ({ artifactId: canonicalArtifactId, manifestDigest: digest('artifact') }) },
        analyzer: { analyze: async () => ({ result: result as never }) }, resultWriter: writer })
      const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: canonicalArtifactId,
        manifestDigest: digest('artifact'), requestedAt: canonicalObservedAt },
      { executorId: 'health-local-analysis', executorType: 'internal', executionToken: `canonical-${purpose}` })
      const prepared = await adapter.prepare(ctx)

      expect((await adapter.execute({ ...ctx, preparedOutput: prepared.output })).outcome).toBe('succeeded')
      expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ result }))
    },
  )

  it('binds consent to the exact artifact/manifest/processor and rejects replay across execution tokens', async () => {
    let consumed = false
    const consume = vi.fn(async request => {
      expect(request).toEqual({ artifactId: 'artifact-1', manifestDigest: digest('artifact'),
        processorId: 'processor-1', consentId: 'consent-1' })
      if (consumed) throw new Error('replayed')
      consumed = true
      return { consentId: request.consentId, consumedAt: '2026-07-14T01:00:00.000Z', authorization: {} as never }
    })
    const analyze = vi.fn(async () => ({ result: finalizedResult(), providerReceiptId: 'receipt-1' }))
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'remote', analyzer: { analyze },
      resultWriter: analysisWriter({ analysisId: 'analysis-1', status: 'succeeded', observationIds: [] }),
      consentConsumer: { consume }, artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) } })
    const base = context('health.artifact.analyze.remote', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z', processorId: 'processor-1', consentId: 'consent-1' },
    { executorId: 'health-remote-analysis' })
    const prepared = await adapter.prepare(base)
    const [first, replay] = await Promise.all([
      adapter.execute({ ...base, preparedOutput: prepared.output, executionToken: 'execution-a' }),
      adapter.execute({ ...base, preparedOutput: prepared.output, executionToken: 'execution-b' }),
    ])
    expect([first.outcome, replay.outcome].sort()).toEqual(['permanent_failure', 'succeeded'])
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('interrupts an in-flight analyzer through its abort signal', async () => {
    let signal!: AbortSignal
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      resultWriter: analysisWriter({ analysisId: 'analysis-1', status: 'succeeded', observationIds: [] }),
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async request => { signal = request.signal; await gate
        return { result: finalizedResult() } } } })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' }, { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)
    const pending = adapter.execute({ ...ctx, preparedOutput: prepared.output })
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(await adapter.interrupt(ctx)).toMatchObject({ outcome: 'unsupported' })
    expect(signal.aborted).toBe(false)
    release()
    await pending
    expect(await adapter.compensate(ctx)).toMatchObject({ outcome: 'unsupported' })
  })

  it('rejects sensitive-shaped analyzer identities instead of persisting them', async () => {
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => ({ result: finalizedResult() }) },
      resultWriter: analysisWriter({ analysisId: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        status: 'succeeded', observationIds: [] }) })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' }, { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)
    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_RESULT_INVALID', output: {} })
  })

  it('sends only to configured self, minimizes content, and never blindly resends an uncertain delivery', async () => {
    const send = vi.fn(async () => ({ status: 'unknown' as const, providerMessageId: null }))
    const lookup = vi.fn()
      .mockResolvedValueOnce({ status: 'not_found' as const, providerMessageId: null })
      .mockResolvedValue({ status: 'unknown' as const, providerMessageId: null })
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: { send, lookup } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-1', recipient: 'configured-self',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    const first = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    const second = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(first).toMatchObject({ outcome: 'unknown', errorCode: 'HEALTH_WEIXIN_DELIVERY_UNCERTAIN' })
    expect(second).toMatchObject({ outcome: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toMatchObject({ recipient: 'configured-self', deliveryId: expect.any(String) })
    expect(send.mock.calls[0][0].message.length).toBeLessThanOrEqual(500)
    expect(send.mock.calls[0][0].message).toContain('action-1')
    expect(send.mock.calls[0][0].message).toContain('/complete')
  })

  it('lets the durable sender exclusively claim a definitive not-sent retry', async () => {
    const accountFingerprint = 'a'.repeat(64)
    const send = vi.fn(async () => ({ status: 'accepted' as const, providerMessageId: 'provider-after-retry' }))
    const lookup = vi.fn(async () => ({ status: 'not_sent' as const, providerMessageId: null }))
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: {
      identity: () => ({ profile: 'default', accountFingerprint }), send, lookup,
    } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'retry-action',
      recipient: 'configured-self', messageCode: 'meal_due' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)

    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output })).toMatchObject({
      outcome: 'succeeded', output: { status: 'accepted', providerMessageId: 'provider-after-retry' },
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ expectedAccountFingerprint: accountFingerprint }))
  })

  it('rejects recipient mismatches and sensitive reminder content before transport', async () => {
    const sender = { send: vi.fn(), lookup: vi.fn() }
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender })
    const mismatch = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-1', recipient: 'someone-else',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(mismatch)).toMatchObject({ outcome: 'failed', errorCode: 'HEALTH_WEIXIN_REQUEST_INVALID' })
    const secret = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-1', recipient: 'configured-self',
      messageCode: 'meal', messageText: 'raw input is forbidden' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(secret)).toMatchObject({ outcome: 'failed' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('binds delivery identity to the exact profile account fingerprint', async () => {
    let accountFingerprint = 'a'.repeat(64)
    const sender = { identity: () => ({ profile: 'default', accountFingerprint }), send: vi.fn(), lookup: vi.fn() }
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'account-bound',
      recipient: 'configured-self', messageCode: 'meal_due' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    accountFingerprint = 'b'.repeat(64)

    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_WEIXIN_PREPARATION_INVALID' })
    const rotated = await adapter.prepare(ctx)
    expect(rotated.output.deliveryId).not.toBe(prepared.output.deliveryId)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('verifies provider identity and resolves a prior uncertain attempt without resending', async () => {
    const send = vi.fn(async () => ({ status: 'unknown' as const, providerMessageId: null }))
    const lookup = vi.fn()
      .mockResolvedValueOnce({ status: 'not_found' as const, providerMessageId: null })
      .mockResolvedValue({ status: 'delivered' as const, providerMessageId: 'message-1' })
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: { send, lookup } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-2', recipient: 'configured-self',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    expect((await adapter.execute({ ...ctx, preparedOutput: prepared.output })).outcome).toBe('unknown')
    const resolved = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(resolved).toMatchObject({ outcome: 'succeeded', output: { status: 'delivered', providerMessageId: 'message-1' } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output,
      executionOutput: { ...resolved.output, status: 'unknown', providerMessageId: null } }))
      .toMatchObject({ outcome: 'verified' })
    expect(await adapter.interrupt(ctx)).toMatchObject({ outcome: 'unsupported' })
    expect(await adapter.compensate(ctx)).toMatchObject({ outcome: 'unsupported' })
  })

  it('fails closed when delivery status lookup itself is unverifiable', async () => {
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: {
      send: vi.fn(), lookup: vi.fn(async () => { throw new Error('unavailable') }),
    } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-3', recipient: 'configured-self',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'unknown', errorCode: 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE', safeToRetry: false })
  })

  it('registers every exact runtime binding including health source', () => {
    expect(createConfiguredHealthFabricExecutorAdapters().map(adapter => adapter.id).sort()).toEqual([
      'health-local-analysis', 'health-plan', 'health-remote-analysis', 'health-shadow', 'health-source', 'health-weixin',
    ])
  })

  it('does not claim interruption when an analyzer ignores abort', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      resultWriter: analysisWriter({ analysisId: 'analysis-1', status: 'succeeded', observationIds: [] }),
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => { await gate; return { result: finalizedResult() } } } })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' }, { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)
    const pending = adapter.execute({ ...ctx, preparedOutput: prepared.output })
    await Promise.resolve()
    expect(await adapter.interrupt(ctx)).toMatchObject({ outcome: 'unsupported' })
    release(); await pending
  })

  it('rejects analyzer identifiers that would violate Task10 semantic output contracts', async () => {
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local',
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => ({ result: finalizedResult() }) },
      resultWriter: analysisWriter({ analysisId: 'not allowed whitespace', status: 'succeeded', observationIds: ['also invalid'] }) })
    const ctx = context('health.artifact.analyze.local', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z' }, { executorId: 'health-local-analysis', executorType: 'internal' })
    const prepared = await adapter.prepare(ctx)
    expect(await adapter.execute({ ...ctx, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_RESULT_INVALID' })
  })

  it('passes execution token and material digest into durable plan/followup repository operations', async () => {
    const scheduleFollowup = vi.fn(async () => ({ followupId: 'followup-1', scheduledAt: '2026-07-15T01:00:00.000Z', status: 'scheduled' as const }))
    const repository = {
      read: vi.fn(), adjust: vi.fn(), restore: vi.fn(), scheduleFollowup,
      readFollowup: vi.fn(async () => ({ followupId: 'followup-1', scheduledAt: '2026-07-15T01:00:00.000Z', status: 'scheduled' as const })),
    } as unknown as HealthPlanRepository
    const adapter = createHealthPlanExecutorAdapter({ repository })
    const ctx = context('health.followup.schedule', { schemaVersion: 1, followupId: 'followup-1', ownerUserId: 'user-1',
      category: 'recovery', operation: 'schedule_pain_followup', reasonCode: 'pain', dueAt: '2026-07-15T01:00:00.000Z' },
    { executorId: 'health-plan', executorType: 'internal', target: { kind: 'health_followup', ownerUserId: 'user-1' } })
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed.outcome).toBe('succeeded')
    expect(scheduleFollowup).toHaveBeenCalledWith(expect.objectContaining({ executionToken: 'execution-1', materialDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }))
  })

  it('recovers a committed plan write in a new adapter through the durable execution ledger', async () => {
    let current = { planId: 'plan-1', version: 3, digest: digest('v3') }
    const ledger = new Map<string, { material: string; result: { previous: typeof current; current: typeof current } }>()
    const repository: HealthPlanRepository = {
      read: async () => ({ ...current }), restore: async () => null,
      adjust: async request => {
        const prior = ledger.get(request.executionToken)
        if (prior) return prior.material === request.materialDigest ? prior.result : null
        if (current.version !== request.expectedVersion || current.digest !== request.expectedDigest) return null
        const previous = { ...current }; current = { planId: 'plan-1', version: 4, digest: digest('v4') }
        const result = { previous, current: { ...current } }
        ledger.set(request.executionToken, { material: request.materialDigest, result })
        return result
      },
    }
    const ctx = context('health.plan.adjust', { schemaVersion: 1, planId: 'plan-1', expectedVersion: 3,
      operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'recovery' },
    { executorId: 'health-plan', executorType: 'internal', target: { kind: 'health_plan', planId: 'plan-1' } })
    const first = createHealthPlanExecutorAdapter({ repository })
    const prepared = await first.prepare(ctx)
    expect((await first.execute({ ...ctx, preparedOutput: prepared.output })).outcome).toBe('succeeded')
    const afterCrash = createHealthPlanExecutorAdapter({ repository })
    expect(await afterCrash.execute({ ...ctx, preparedOutput: prepared.output })).toMatchObject({ outcome: 'succeeded', output: { newVersion: 4 } })
    const changedMaterial = { ...ctx, input: { ...ctx.input, reasonCode: 'different' } }
    expect(await afterCrash.execute({ ...changedMaterial, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_PLAN_CAS_CONFLICT' })
  })

  it('coalesces concurrent same-token Weixin execute calls before the first await', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => { await gate; return { status: 'accepted' as const, providerMessageId: 'message-1' } })
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: {
      send, lookup: vi.fn(async () => ({ status: 'not_found' as const, providerMessageId: null })),
    } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-4', recipient: 'configured-self',
      messageCode: 'meal_due' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    const first = adapter.execute({ ...ctx, preparedOutput: prepared.output })
    const second = adapter.execute({ ...ctx, preparedOutput: prepared.output })
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    release(); await Promise.all([first, second])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('uses allowlisted reminder templates and rejects unknown message codes', async () => {
    const sender = { send: vi.fn(), lookup: vi.fn() }
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender })
    const unknown = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-5', recipient: 'configured-self',
      messageCode: 'unknown-code' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(unknown)).toMatchObject({ outcome: 'failed' })
  })

  it('never verifies accepted delivery without an identity bound to the stable delivery id', async () => {
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: {
      send: vi.fn(), lookup: vi.fn(async () => ({ status: 'accepted' as const, providerMessageId: null })),
    } })
    const ctx = context('health.reminder.send', { schemaVersion: 2, actionId: 'action-6', recipient: 'configured-self',
      messageCode: 'meal_due' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: {
      schemaVersion: 1, deliveryId: prepared.output.deliveryId, status: 'accepted', providerMessageId: null,
    } })).toMatchObject({ outcome: 'failed', errorCode: 'HEALTH_WEIXIN_VERIFICATION_INVALID' })
  })

  it('persists canonical analysis results through a durable writer and replays committed IDs after restart', async () => {
    const evidenceArtifactId = `artifact-${'a'.repeat(64)}`
    const canonicalResult = {
      schemaVersion: 'health-analysis-result/v1' as const, purpose: 'skin' as const, status: 'completed' as const,
      modelVersion: 'vision-1', parserVersion: 'vision-json-v1', overallConfidence: 0.9,
      captureQuality: { score: 0.9, reasons: [] },
      fields: [{ field: 'appearances', value: [], confidence: 0.9,
        evidence: { artifactId: evidenceArtifactId, region: 'face' } }],
      envelope: { domain: 'skin' as const, source: 'analysis.remote', sourceId: 'analysis-source',
        observedAt: '2026-07-14T01:00:00Z', evidenceClass: 'inferred' as const, confidence: 0.9,
        payload: { appearances: [], captureQuality: 0.9 }, artifactIds: [evidenceArtifactId], parserVersion: 'vision-json-v1' },
    }
    type Stored = { executionToken: string; materialDigest: string; artifactId: string; manifestDigest: string;
      processorId: string; reservationId: string; requestedAt: string; analysisId: string; status: 'succeeded';
      observationIds: string[]; processorReceiptId: string; verificationStatus: 'verified' }
    const ledger = new Map<string, Stored>()
    let lookupCount = 0
    const writer = {
      lookup: vi.fn(async (executionToken: string) => {
        lookupCount += 1
        if (lookupCount === 1) return null
        if (lookupCount === 2) throw new Error('simulated crash window')
        return ledger.get(executionToken) ?? null
      }),
      write: vi.fn(async (request: { executionToken: string; materialDigest: string; result: unknown;
        artifactId: string; manifestDigest: string; processorId: string; reservationId: string; requestedAt: string;
        processorReceiptId: string }) => {
        expect(request.result).toEqual(canonicalResult)
        const record: Stored = { executionToken: request.executionToken, materialDigest: request.materialDigest,
          artifactId: request.artifactId, manifestDigest: request.manifestDigest, processorId: request.processorId,
          reservationId: request.reservationId, requestedAt: request.requestedAt,
          analysisId: 'analysis-persisted-1', status: 'succeeded',
          observationIds: Array.from({ length: 70 }, (_, index) => `observation-${index + 1}`),
          processorReceiptId: request.processorReceiptId, verificationStatus: 'verified' }
        ledger.set(request.executionToken, record)
        throw new Error('committed before process crash')
      }),
    }
    const consume = vi.fn(async () => ({ consentId: 'reservation-1', consumedAt: '2026-07-14T01:00:00.000Z',
      authorization: {} as never }))
    const analyze = vi.fn(async () => ({ result: canonicalResult, providerReceiptId: 'provider-receipt-1' }))
    const options = { locality: 'remote' as const, consentConsumer: { consume }, analyzer: { analyze }, resultWriter: writer,
      artifactResolver: { resolve: async () => ({ artifactId: evidenceArtifactId, manifestDigest: digest('artifact') }) } }
    const ctx = context('health.artifact.analyze.remote', { schemaVersion: 1, artifactId: evidenceArtifactId,
      manifestDigest: digest('artifact'), requestedAt: '2026-07-14T01:00:00.000Z', processorId: 'processor-1',
      consentId: 'reservation-1' }, { executorId: 'health-remote-analysis' })
    const first = createHealthAnalysisExecutorAdapter(options)
    const prepared = await first.prepare(ctx)
    expect(await first.execute({ ...ctx, preparedOutput: prepared.output })).toMatchObject({ outcome: 'unknown' })

    const restarted = createHealthAnalysisExecutorAdapter(options)
    expect(await restarted.execute({ ...ctx, preparedOutput: prepared.output })).toMatchObject({ outcome: 'succeeded', output: {
      analysisId: 'analysis-persisted-1', observationIds: expect.arrayContaining(['observation-1']),
      totalCount: 70, omittedCount: 6, continuationCursor: 'analysis:analysis-persisted-1:64',
      processorReceiptId: 'provider-receipt-1', verificationStatus: 'verified',
    } })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(writer.write).toHaveBeenCalledTimes(1)

    const changed = { ...ctx, input: { ...ctx.input, requestedAt: '2026-07-14T01:01:00.000Z' } }
    expect(await restarted.execute({ ...changed, preparedOutput: prepared.output }))
      .toMatchObject({ outcome: 'permanent_failure', errorCode: 'HEALTH_ANALYSIS_EXECUTION_TOKEN_CONFLICT' })
  })

  it('never invents a remote provider receipt when the provider supplied none', async () => {
    type PersistedAnalysis = {
      executionToken: string; materialDigest: string; artifactId: string; manifestDigest: string;
      processorId: string; reservationId: string; requestedAt: string; analysisId: string;
      status: 'needs_review'; observationIds: string[]; processorReceiptId: string | null;
      verificationStatus: 'unverifiable';
    }
    let persisted: PersistedAnalysis | null = null
    const writer = {
      lookup: vi.fn(async (executionToken: string, materialDigest: string) =>
        persisted?.executionToken === executionToken && persisted.materialDigest === materialDigest ? persisted : null),
      write: vi.fn(async (request: { executionToken: string; materialDigest: string; artifactId: string;
        manifestDigest: string; processorId: string; reservationId: string; requestedAt: string;
        processorReceiptId: string | null }) => (persisted = {
        executionToken: request.executionToken, materialDigest: request.materialDigest,
        artifactId: request.artifactId, manifestDigest: request.manifestDigest, processorId: request.processorId,
        reservationId: request.reservationId, requestedAt: request.requestedAt,
        analysisId: 'analysis-unverifiable', status: 'needs_review' as const, observationIds: [],
        processorReceiptId: request.processorReceiptId, verificationStatus: 'unverifiable' as const,
      })),
    }
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'remote', resultWriter: writer,
      consentConsumer: { consume: async () => ({ consentId: 'reservation-no-receipt',
        consumedAt: canonicalObservedAt, authorization: {} as never }) },
      analyzer: { analyze: async () => ({ result: finalizedResult() }) },
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) } })
    const ctx = context('health.artifact.analyze.remote', { schemaVersion: 1, artifactId: 'artifact-1',
      manifestDigest: digest('artifact'), requestedAt: canonicalObservedAt, processorId: 'processor-1',
      consentId: 'reservation-no-receipt' }, { executorId: 'health-remote-analysis', executionToken: 'no-provider-receipt' })
    const prepared = await adapter.prepare(ctx)

    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({
      outcome: 'unknown', output: { processorReceiptId: null, verificationStatus: 'unverifiable', status: 'needs_review' },
    })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'unknown', errorCode: 'HEALTH_ANALYSIS_PROVIDER_UNVERIFIABLE' })
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ processorReceiptId: null }))
  })
})
