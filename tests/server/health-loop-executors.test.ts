import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric'
import { createHealthShadowExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/shadow'
import { createHealthPlanExecutorAdapter, type HealthPlanRepository } from '../../packages/server/src/services/hermes/health-loop/executors/plan'
import { createHealthAnalysisExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/analysis'
import { createHealthWeixinExecutorAdapter } from '../../packages/server/src/services/hermes/health-loop/executors/weixin'
import { createConfiguredHealthFabricExecutorAdapters } from '../../packages/server/src/services/hermes/health-loop/executors/configuration'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

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
      schemaVersion: 1, actionId: 'action-1', recipient: 'configured-self', messageCode: 'eat',
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
    const analyze = vi.fn(async () => ({ analysisId: 'analysis-1', status: 'succeeded' as const,
      observationIds: ['observation-1'], processorReceiptId: 'receipt-1' }))
    const adapter = createHealthAnalysisExecutorAdapter({
      locality: 'remote', consentConsumer: { consume }, analyzer: { analyze },
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
    await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('keeps local analysis local and never consumes remote consent', async () => {
    const consume = vi.fn()
    const analyze = vi.fn(async () => ({ analysisId: 'analysis-local', status: 'needs_review' as const, observationIds: [] }))
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'local', analyzer: { analyze },
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

  it('binds consent to the exact artifact/manifest/processor and rejects replay across execution tokens', async () => {
    let consumed = false
    const consume = vi.fn(async request => {
      expect(request).toEqual({ artifactId: 'artifact-1', manifestDigest: digest('artifact'),
        processorId: 'processor-1', consentId: 'consent-1' })
      if (consumed) throw new Error('replayed')
      consumed = true
      return { consentId: request.consentId, consumedAt: '2026-07-14T01:00:00.000Z', authorization: {} as never }
    })
    const analyze = vi.fn(async () => ({ analysisId: 'analysis-1', status: 'succeeded' as const,
      observationIds: [], processorReceiptId: 'receipt-1' }))
    const adapter = createHealthAnalysisExecutorAdapter({ locality: 'remote', analyzer: { analyze },
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
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async request => { signal = request.signal; await gate
        return { analysisId: 'analysis-1', status: 'succeeded', observationIds: [] } } } })
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
      analyzer: { analyze: async () => ({ analysisId: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        status: 'succeeded', observationIds: [] }) } })
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
    const ctx = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-1', recipient: 'configured-self',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    const first = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    const second = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(first).toMatchObject({ outcome: 'unknown', errorCode: 'HEALTH_WEIXIN_DELIVERY_UNCERTAIN' })
    expect(second).toMatchObject({ outcome: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ recipient: 'configured-self', deliveryId: expect.any(String) })
    expect(send.mock.calls[0][0].message.length).toBeLessThanOrEqual(500)
    expect(send.mock.calls[0][0].message).toContain('action-1')
    expect(send.mock.calls[0][0].message).toContain('/complete')
  })

  it('rejects recipient mismatches and sensitive reminder content before transport', async () => {
    const sender = { send: vi.fn(), lookup: vi.fn() }
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender })
    const mismatch = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-1', recipient: 'someone-else',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(mismatch)).toMatchObject({ outcome: 'failed', errorCode: 'HEALTH_WEIXIN_REQUEST_INVALID' })
    const secret = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-1', recipient: 'configured-self',
      messageCode: 'meal', messageText: 'raw input is forbidden' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(secret)).toMatchObject({ outcome: 'failed' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('verifies provider identity and resolves a prior uncertain attempt without resending', async () => {
    const send = vi.fn(async () => ({ status: 'unknown' as const, providerMessageId: null }))
    const lookup = vi.fn()
      .mockResolvedValueOnce({ status: 'not_found' as const, providerMessageId: null })
      .mockResolvedValue({ status: 'delivered' as const, providerMessageId: 'message-1' })
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: { send, lookup } })
    const ctx = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-2', recipient: 'configured-self',
      messageCode: 'meal' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    expect((await adapter.execute({ ...ctx, preparedOutput: prepared.output })).outcome).toBe('unknown')
    const resolved = await adapter.execute({ ...ctx, preparedOutput: prepared.output })
    expect(resolved).toMatchObject({ outcome: 'unknown' })
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
    const ctx = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-3', recipient: 'configured-self',
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
      artifactResolver: { resolve: async () => ({ artifactId: 'artifact-1', manifestDigest: digest('artifact') }) },
      analyzer: { analyze: async () => { await gate; return { analysisId: 'analysis-1', status: 'succeeded', observationIds: [] } } } })
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
      analyzer: { analyze: async () => ({ analysisId: 'not allowed whitespace', status: 'succeeded', observationIds: ['also invalid'] }) } })
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
    const ctx = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-4', recipient: 'configured-self',
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
    const unknown = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-5', recipient: 'configured-self',
      messageCode: 'unknown-code' }, { executorId: 'health-weixin' })
    expect(await adapter.prepare(unknown)).toMatchObject({ outcome: 'failed' })
  })

  it('never verifies accepted delivery without an identity bound to the stable delivery id', async () => {
    const adapter = createHealthWeixinExecutorAdapter({ profile: 'default', sender: {
      send: vi.fn(), lookup: vi.fn(async () => ({ status: 'accepted' as const, providerMessageId: null })),
    } })
    const ctx = context('health.reminder.send', { schemaVersion: 1, actionId: 'action-6', recipient: 'configured-self',
      messageCode: 'meal_due' }, { executorId: 'health-weixin' })
    const prepared = await adapter.prepare(ctx)
    expect(await adapter.verify({ ...ctx, preparedOutput: prepared.output, executionOutput: {
      schemaVersion: 1, deliveryId: prepared.output.deliveryId, status: 'accepted', providerMessageId: null,
    } })).toMatchObject({ outcome: 'failed', errorCode: 'HEALTH_WEIXIN_VERIFICATION_INVALID' })
  })
})
