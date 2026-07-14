import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric'
import type { HealthIngestionEnvelope } from '../../packages/server/src/services/hermes/health-loop'

const observedAt = '2026-07-14T08:00:00.000Z'
const projectionAt = '2026-07-14T08:05:00.000Z'

const fixtures: HealthIngestionEnvelope[] = [
  { domain: 'body_composition', source: 'mi-s400', sourceId: 's400-e2e', observedAt,
    evidenceClass: 'measured', confidence: 0.99, payload: {
      weightKg: 84.2, bmi: 26.6, bodyFatPercent: 21.4, muscleMassKg: 62.1,
    } },
  { domain: 'sleep', source: 'mi-fitness', sourceId: 'sleep-e2e', observedAt,
    evidenceClass: 'measured', confidence: 0.95, payload: {
      startedAt: '2026-07-14T03:00:00.000Z', endedAt: observedAt,
      durationMinutes: 300, interruptions: 2, freshnessMinutes: 5, recoveryScore: 42,
    } },
  { domain: 'diet', source: 'meal-log', sourceId: 'diet-e2e', observedAt,
    evidenceClass: 'reported', confidence: 0.9, payload: {
      foods: [{ name: 'rice', portionGrams: 180 }], caloriesKcal: 520,
      proteinG: 30, carbsG: 65, fatG: 14, portionConfirmed: true,
    } },
]

describe('Phase 4 health closed loop', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'health-loop-e2e-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(home, { recursive: true, force: true })
  })

  it('runs the synthetic loop exactly once, recovers a crash, records an immutable outcome, and recomputes strategy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(observedAt)
    const health = await import('../../packages/server/src/services/hermes/health-loop')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const { createHealthOutboxProcessor } = await import('../../packages/server/src/services/hermes/health-loop/runtime')
    const { recordHealthOutcome } = await import('../../packages/server/src/services/hermes/health-loop/outcomes')

    const first = health.ingestHealthEnvelopesAtomically(fixtures)
    const observationCount = twin.listTwinObservations({ entityId: 'person:self' }).length
    const eventCount = twin.listTwinEvents({ eventType: 'health.ingestion.recorded', limit: 100 }).length
    expect(first.map(item => item.status)).toEqual(['new', 'new', 'new'])
    expect(health.ingestHealthEnvelopesAtomically(fixtures).map(item => item.status))
      .toEqual(['replayed', 'replayed', 'replayed'])
    expect(twin.listTwinObservations({ entityId: 'person:self' })).toHaveLength(observationCount)
    expect(twin.listTwinEvents({ eventType: 'health.ingestion.recorded', limit: 100 })).toHaveLength(eventCount)

    const observations = twin.listTwinObservations({ entityId: 'person:self' })
    const computed = health.computeHealthProjections(observations, { computedAt: projectionAt })
    expect(health.computeHealthProjections([...observations].reverse(), { computedAt: projectionAt })).toEqual(computed)
    const projected = health.projectHealthState(observations, { computedAt: projectionAt })
    expect(Object.keys(projected.projections)).toHaveLength(9)
    expect(projected.persisted).toHaveLength(9)
    const initial = health.decideHealthInterventions({ projections: projected.persisted, now: projectionAt,
      plan: { trainingIntensity: 'high', proteinTargetG: 120 } })
    expect(initial.primary).toMatchObject({ id: 'health.training.reduce_after_low_recovery', category: 'training',
      capabilityId: 'health.plan.adjust' })

    const intents: Array<Record<string, unknown>> = []
    let crash = true
    const processor = (workerId: string) => createHealthOutboxProcessor({ consumerId: 'health-loop-v1', workerId,
      now: () => '2026-07-14T08:05:01.000Z', createIntent(input) {
        intents.push(structuredClone(input)); return { intentId: 'intent-e2e', workflowId: 'workflow-e2e' }
      }, afterIntent() { if (crash) { crash = false; throw new Error('HEALTH_RUNTIME_SIMULATED_CRASH') } } })
    await expect(processor('worker-before-restart').processOnce()).rejects.toThrow('HEALTH_RUNTIME_SIMULATED_CRASH')
    await expect(processor('worker-after-restart').processOnce({ now: '2026-07-14T08:05:32.000Z' }))
      .resolves.toMatchObject({ processed: true, outcome: 'completed' })
    expect(intents).toHaveLength(2)
    expect(intents[0]).toEqual(intents[1])
    expect(intents[0]).toMatchObject({ environments: ['sandbox'] })
    expect(JSON.stringify(intents)).not.toContain('weixin')

    const action = twin.withPersonalTwinDb(db => db.prepare(`SELECT action_id,intervention_id,workflow_id,user_id
      FROM twin_health_actions`).get()) as { action_id:string; intervention_id:string; workflow_id:string; user_id:string }
    const outcome = recordHealthOutcome({ feedbackId: 'feedback-e2e', outcome: 'completed', actionId: action.action_id,
      interventionId: action.intervention_id, workflowId: action.workflow_id, userId: action.user_id,
      occurredAt: '2026-07-14T08:06:00.000Z' })
    expect(outcome.reviewRequired).toBe(false)
    expect(recordHealthOutcome({ feedbackId: 'feedback-e2e', outcome: 'completed', actionId: action.action_id,
      interventionId: action.intervention_id, workflowId: action.workflow_id, userId: action.user_id,
      occurredAt: outcome.occurredAt })).toEqual(outcome)
    expect(() => recordHealthOutcome({ feedbackId: 'feedback-e2e', outcome: 'adverse_feedback',
      actionId: action.action_id, interventionId: action.intervention_id, workflowId: action.workflow_id,
      userId: action.user_id, occurredAt: outcome.occurredAt })).toThrow('HEALTH_OUTCOME_IDEMPOTENCY_CONFLICT')
    const recomputed = health.decideHealthInterventions({ projections: projected.persisted,
      now: '2026-07-14T08:06:01.000Z', plan: { trainingIntensity: 'high', proteinTargetG: 120 },
      recentActions: [{ candidateId: action.intervention_id, category: initial.primary!.category,
        actedAt: outcome.occurredAt }] })
    expect(recomputed.primary?.id).not.toBe(initial.primary?.id)
  })

  it('rejects remote processing without exact one-time consent and gates a provider flag behind approval', async () => {
    const health = await import('../../packages/server/src/services/hermes/health-loop')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const vault = health.createHealthArtifactVault({ accessController: {
      secureDirectory: async () => undefined, secureFile: async () => undefined,
    } })
    const artifact = await vault.store({ content: Buffer.from('%PDF-1.7\nhealth-e2e'),
      declaredMediaType: 'application/pdf', source: 'e2e', sourceId: 'report', metadata: {} })
    const broker = health.createHealthConsentBroker({ allowedProcessors: ['processor:e2e'],
      clock: () => new Date('2026-07-14T08:00:00.000Z') })
    const manifest = { artifactIds: [artifact.id], processor: 'processor:e2e', purpose: 'internal_health' as const,
      selectedRegions: ['page:1/lab'], requestedFields: ['markers'], retention: 'no_retention' as const }
    const grant = await broker.issue(manifest)
    await expect(broker.reserve(grant.token, { ...manifest, requestedFields: ['diagnosis'] }, {
      artifactId: artifact.id, artifactManifestDigest: 'a'.repeat(64), processorId: 'processor:e2e',
    })).rejects.toThrow('HEALTH_CONSENT_INVALID')

    twin.upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
    twin.recordTwinObservation({ entityId: 'person:self', metric: 'health.internal_health.markers', value: [{
      key: 'marker_x', value: 12, unit: 'u/L', referenceInterval: { low: 1, high: 10 }, measuredAt: observedAt,
      providerFlag: 'high', evidence: { page: 1, region: 'lab' },
    }], unit: null, observedAt, source: 'user-confirmation', sourceId: 'flagged-e2e-confirmed', actor: 'user-self',
      confidence: 0.95, confirmationState: 'confirmed', evidence: [{ evidenceClass: 'measured' }] })
    const projected = health.projectHealthState(twin.listTwinObservations({ entityId: 'person:self' }), {
      computedAt: projectionAt,
    })
    expect(projected.projections['health.internal_state'])
      .toMatchObject({ state: { confirmedCount: 1, pendingCount: 0 }, freshness: { status: 'fresh' } })
    expect(health.decideHealthInterventions({ projections: projected.persisted, now: projectionAt }).primary)
      .toMatchObject({ id: 'health.internal.review_provider_flag', authority: 'approval', risk: 'medium' })
  })

  it('captures a fake live Weixin receipt, honors emergency stop, and escalates adverse feedback', async () => {
    const { createHealthWeixinExecutorAdapter } = await import(
      '../../packages/server/src/services/hermes/health-loop/executors/weixin'
    )
    const fabric = await import('../../packages/server/src/services/hermes/action-fabric')
    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    const send = vi.fn(async () => ({ status: 'accepted' as const, providerMessageId: 'fake-message-e2e' }))
    const lookup = vi.fn()
      .mockResolvedValueOnce({ status: 'not_found' as const, providerMessageId: null })
      .mockResolvedValue({ status: 'delivered' as const, providerMessageId: 'fake-message-e2e' })
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: { send, lookup } })
    const ctx = weixinContext()
    const prepared = await adapter.prepare(ctx)
    const executed = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: {
      status: 'accepted', providerMessageId: 'fake-message-e2e', deliveryId: expect.any(String),
    } })
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified', output: { providerMessageId: 'fake-message-e2e' } })
    expect(send).toHaveBeenCalledOnce()

    fabric.ensureBuiltInFabricRegistry()
    const stopped = fabric.setFabricEmergencyStop(2, 'admin-e2e', 'stop health effects', 0)
    expect(stopped).toMatchObject({ level: 2, version: 1 })
    expect(fabric.getFabricControlState()).toEqual(stopped)

    const { registerHealthRuntimeAction, recordHealthOutcome } = await import(
      '../../packages/server/src/services/hermes/health-loop/outcomes'
    )
    twin.withPersonalTwinDb(db => db.prepare(`INSERT INTO twin_outbox
      (id,topic,aggregate_id,payload_json,status,available_at,created_at)
      VALUES('outbox-adverse','twin.event.recorded','event-adverse','{}','published',?,?)`)
      .run(observedAt, observedAt))
    registerHealthRuntimeAction({ actionId: 'health-action-adverse', interventionId: 'health.recovery.reduce_load',
      workflowId: 'workflow-adverse', userId: 'user-self', capabilityId: 'health.plan.adjust', category: 'recovery',
      priority: 95, supersedable: false, risk: 'low', authority: 'auto', sourceOutboxId: 'outbox-adverse',
      effectiveDate: '2026-07-14', supersedes: [], createdAt: '2026-07-14T08:00:00.000Z' })
    expect(recordHealthOutcome({ feedbackId: 'feedback-adverse', outcome: 'adverse_feedback',
      actionId: 'health-action-adverse', interventionId: 'health.recovery.reduce_load', workflowId: 'workflow-adverse',
      userId: 'user-self', occurredAt: '2026-07-14T08:10:00.000Z' })).toMatchObject({ reviewRequired: true })
    expect(twin.listTwinEvents({ eventType: 'health.review.requested', limit: 10 })).toHaveLength(1)
  })
})

function weixinContext(): FabricExecutionContext {
  return { intentId: 'intent-live', workflowId: 'workflow-live', stepId: 'step-live', executorId: 'health-weixin',
    executorType: 'connector', capabilityId: 'health.reminder.send', capabilityVersion: 2,
    contractDigest: createHash('sha256').update('health.reminder.send').digest('hex'),
    policyEvaluationToken: 'policy-live', executionToken: 'execution-live',
    input: { schemaVersion: 2, actionId: 'action-live', recipient: 'configured-self', messageCode: 'recovery_check' },
    target: { kind: 'health_recipient', recipient: 'configured-self' }, now: '2026-07-14T08:00:00.000Z' }
}
