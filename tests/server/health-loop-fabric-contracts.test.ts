import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  invokeFabricExecutor,
  prepareFabricCompensation,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  type FabricExecutorAdapter,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  clearFabricAuthorizationProvider,
  registerFabricAuthorizationProvider,
} from '../../packages/server/src/services/hermes/action-fabric/authorization'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'
import { healthTargetAtoms } from '../../packages/server/src/services/hermes/action-fabric/contracts'

describe('health Action Fabric closed contracts', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-health-fabric-contracts-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'health-contract-test-managed-key-at-least-32-bytes'
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.source.sync'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
        allowedTargets: ['health:connector:s400'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
  })

  afterEach(() => {
    unregisterFabricExecutorAdapter('health-source')
    unregisterFabricExecutorAdapter('health-plan')
    clearFabricAuthorizationProvider()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    rmSync(home, { recursive: true, force: true })
  })

  it('requires an exact structured target bound to the same input values', () => {
    const base = request()
    expect(createFabricIntent(base).policyDecision.outcome).toBe('waiting_user')
    for (const target of [
      { kind: 'health_connector', connectorId: 'other' },
      { kind: 'health_connector', connectorId: 's400', extra: true },
      { id: 'connector:exact_configured_id' },
    ]) {
      expect(createFabricIntent({ ...base, idempotencyKey: `bad-target-${Math.random().toString(36).slice(2)}`, target }).policyDecision)
        .toMatchObject({ outcome: 'deny', reasonCodes: expect.arrayContaining(['target_not_allowed']) })
    }
  })

  it('defaults health intents to sandbox while preserving explicit live selection', () => {
    const { environments: _environment, ...sandbox } = request()
    expect(createFabricIntent(sandbox).policyDecision).toMatchObject({ outcome: 'allow', executorId: 'health-shadow',
      policySnapshot: { environments: ['sandbox'] } })
    expect(createFabricIntent({ ...request(), idempotencyKey: 'source-live' }).policyDecision)
      .toMatchObject({ outcome: 'waiting_user', executorId: 'health-source',
        policySnapshot: { environments: ['production'], authorizationMode: 'per_action' } })
  })

  it('requires live versioned provider evidence and rechecks its exact authorization material', () => {
    registerFabricAuthorizationProvider({
      id: 'test-health-authorization', version: 3,
      authorize: request => ({ authorizationVersion: 7, expiresAt: '2099-01-01T00:00:00.000Z',
        grantedRequirements: [...request.requirements] }),
    })
    const authorized = createFabricIntent({ ...request(), idempotencyKey: 'source-authorized' })
    expect(authorized.policyDecision).toMatchObject({ outcome: 'allow', policySnapshot: {
      authorizationMode: 'standing_provider', authorizationEvidence: {
        providerId: 'test-health-authorization', providerVersion: 3, authorizationVersion: 7,
        expiresAt: '2099-01-01T00:00:00.000Z', digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    } })
    clearFabricAuthorizationProvider()
    registerFabricAuthorizationProvider({
      id: 'failing-health-authorization', version: 1,
      authorize: () => { throw new Error('provider unavailable') },
    })
    expect(createFabricIntent({ ...request(), idempotencyKey: 'source-provider-failure' }).policyDecision)
      .toMatchObject({ outcome: 'waiting_user', policySnapshot: { authorizationMode: 'per_action' } })
  })

  it.each([
    [{ schemaVersion: 1, connectorId: 's400', apiKey: 'secret' }],
    [{ schemaVersion: 1, connectorId: 42 }],
    [{ schemaVersion: 1, connectorId: 's400', requestedAt: 'not-a-date' }],
  ])('rejects input outside the registered JSON schema before workflow persistence', input => {
    const suffix = typeof input.connectorId === 'string' ? input.connectorId : String(input.connectorId)
    expect(() => createFabricIntent({ ...request(), idempotencyKey: `invalid-input-${suffix}-${Object.keys(input).length}`, input }))
      .toThrow(/FABRIC_(?:CAPABILITY_INPUT_INVALID|WORKFLOW_SENSITIVE_PAYLOAD)/)
  })

  it('binds every health target to canonical role atoms, including both remote artifact and processor', () => {
    expect(healthTargetAtoms('health.source.sync', { kind: 'health_connector', connectorId: 's400' },
      { connectorId: 's400' })).toEqual(['health:connector:s400'])
    expect(healthTargetAtoms('health.artifact.analyze.local', {
      kind: 'health_artifact', artifactId: 'artifact-1', manifestDigest: 'a'.repeat(64),
    }, { artifactId: 'artifact-1', manifestDigest: 'a'.repeat(64) })).toEqual([
      `health:artifact:artifact-1:${'a'.repeat(64)}`,
    ])
    expect(healthTargetAtoms('health.artifact.analyze.remote', {
      kind: 'health_remote_artifact', artifactId: 'artifact-1', manifestDigest: 'a'.repeat(64), processorId: 'processor-1',
    }, { artifactId: 'artifact-1', manifestDigest: 'a'.repeat(64), processorId: 'processor-1' })).toEqual([
      `health:artifact:artifact-1:${'a'.repeat(64)}`, 'health:processor:processor-1',
    ])
    expect(healthTargetAtoms('health.plan.adjust', { kind: 'health_plan', planId: 'daily-plan' },
      { planId: 'daily-plan' })).toEqual(['health:plan:daily-plan'])
    expect(healthTargetAtoms('health.plan.restore', { kind: 'health_plan', planId: 'daily-plan' },
      { planId: 'daily-plan' })).toEqual(['health:plan:daily-plan'])
    expect(healthTargetAtoms('health.reminder.send', { kind: 'health_recipient', recipient: 'configured-self' },
      { recipient: 'configured-self' })).toEqual(['health:recipient:configured-self'])
    expect(healthTargetAtoms('health.checkin.request', { kind: 'health_recipient', recipient: 'configured-self' },
      { recipient: 'configured-self' })).toEqual(['health:recipient:configured-self'])
    expect(healthTargetAtoms('health.followup.schedule', { kind: 'health_followup', ownerUserId: 'user-1' },
      { ownerUserId: 'user-1' })).toEqual(['health:owner:user-1'])
  })

  it('derives effective risk from trusted plan semantics and keeps medium operations waiting for approval', () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.plan.adjust'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
        allowedTargets: ['health:plan:daily-plan'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    const base = {
      capabilityId: 'health.plan.adjust', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      goal: 'adjust safely', target: { kind: 'health_plan', planId: 'daily-plan' }, constraints: {}, rationale: 'rule',
      environments: ['internal'] as Array<'internal'>,
    }
    const low = createFabricIntent({ ...base, idempotencyKey: 'risk-low', input: {
      schemaVersion: 1, planId: 'daily-plan', expectedVersion: 1, operation: 'reduce_training_intensity',
      maximumIntensity: 'low', reasonCode: 'low_sleep',
    } })
    expect(low.policyDecision).toMatchObject({ outcome: 'allow',
      policySnapshot: { capabilityRisk: 'low', effectiveRisk: 'low' } })
    const medium = createFabricIntent({ ...base, idempotencyKey: 'risk-medium', input: {
      schemaVersion: 1, planId: 'daily-plan', expectedVersion: 1,
      operation: 'review_energy_deficit', reasonCode: 'weight_loss_velocity_over_one_percent',
    } })
    expect(medium.policyDecision).toMatchObject({ outcome: 'waiting_user',
      reasonCodes: expect.arrayContaining(['risk_requires_approval']),
      policySnapshot: { capabilityRisk: 'low', effectiveRisk: 'medium' } })
  })

  it('keeps remote disclosure and medical/provider follow-up outside standing authorization', () => {
    const digest = 'a'.repeat(64)
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.artifact.analyze.remote', 'health.followup.schedule'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'low', allowedTargets: [
        `health:artifact:artifact-1:${digest}`, 'health:processor:processor-1', 'health:owner:user-1',
      ] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    const common = { requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      constraints: {}, rationale: 'rule' }
    const remote = createFabricIntent({ ...common, capabilityId: 'health.artifact.analyze.remote',
      idempotencyKey: 'remote-disclosure', goal: 'authorized remote analysis', environments: ['production'],
      target: { kind: 'health_remote_artifact', artifactId: 'artifact-1', manifestDigest: digest, processorId: 'processor-1' },
      input: { schemaVersion: 1, artifactId: 'artifact-1', manifestDigest: digest, processorId: 'processor-1',
        consentId: 'consent-1', requestedAt: '2026-07-14T00:00:00.000Z' },
    })
    expect(remote.policyDecision).toMatchObject({ outcome: 'waiting_user',
      policySnapshot: { effectiveRisk: 'medium' } })
    const followup = createFabricIntent({ ...common, capabilityId: 'health.followup.schedule',
      idempotencyKey: 'provider-followup', goal: 'schedule provider review', environments: ['internal'],
      target: { kind: 'health_followup', ownerUserId: 'user-1' },
      input: { schemaVersion: 1, followupId: 'followup-1', ownerUserId: 'user-1', category: 'measurement',
        operation: 'schedule_provider_flag_review', reasonCode: 'source_reported_marker_flag',
        dueAt: '2026-07-15T00:00:00.000Z' },
    })
    expect(followup.policyDecision).toMatchObject({ outcome: 'waiting_user',
      policySnapshot: { capabilityRisk: 'medium', effectiveRisk: 'medium' } })
  })

  it('rejects a follow-up whose exact owner differs from the requesting user even when the role allows its atom', () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.followup.schedule'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['health:owner:user-2'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    const result = createFabricIntent({
      capabilityId: 'health.followup.schedule', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'cross-owner', goal: 'schedule followup', environments: ['internal'],
      target: { kind: 'health_followup', ownerUserId: 'user-2' }, constraints: {}, rationale: 'test',
      input: { schemaVersion: 1, followupId: 'followup-2', ownerUserId: 'user-2', category: 'measurement',
        operation: 'schedule_provider_flag_review', reasonCode: 'source_reported_marker_flag',
        dueAt: '2026-07-15T00:00:00.000Z' },
    })
    expect(result.policyDecision).toMatchObject({ outcome: 'deny',
      reasonCodes: expect.arrayContaining(['target_not_allowed']) })
  })

  it('does not grant trusted restore authority through the public compensation preparer', () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.plan.restore'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'none', allowedTargets: ['health:plan:daily-plan'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    const prepared = prepareFabricCompensation({
      capabilityId: 'health.plan.restore', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'standalone-restore', goal: 'restore', environments: ['internal'],
      target: { kind: 'health_plan', planId: 'daily-plan' }, constraints: {}, rationale: 'standalone',
      input: { schemaVersion: 1, planId: 'daily-plan', expectedCurrentVersion: 4,
        restoreVersion: 3, restoreDigest: 'a'.repeat(64) },
    })
    expect(evaluateFabricPolicy(prepared.input)).toMatchObject({ outcome: 'waiting_user',
      policySnapshot: { authorizationMode: 'per_action' } })
  })

  it.each([
    [{ schemaVersion: 1, planId: 'daily-plan', previousVersion: 2, newVersion: 3,
      previousDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }],
    [{ schemaVersion: 1, planId: 'daily-plan', previousVersion: 3, newVersion: 5,
      previousDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) }],
    [{ schemaVersion: 1, planId: 'daily-plan', previousVersion: 3, newVersion: 4,
      previousDigest: 'wrong', planDigest: 'b'.repeat(64) }],
  ])('rejects malicious plan adjust CAS output: %j', async output => {
    await expect(invokePlanExecute('health.plan.adjust', {
      schemaVersion: 1, planId: 'daily-plan', expectedVersion: 3, operation: 'reduce_training_intensity',
      maximumIntensity: 'low', reasonCode: 'low_sleep',
    }, output)).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION' })
  })

  it.each([
    [{ schemaVersion: 1, planId: 'daily-plan', restoredVersion: 2, planDigest: 'a'.repeat(64), status: 'restored' }],
    [{ schemaVersion: 1, planId: 'daily-plan', restoredVersion: 3, planDigest: 'b'.repeat(64), status: 'restored' }],
    [{ schemaVersion: 1, planId: 'daily-plan', restoredVersion: 3, planDigest: 'a'.repeat(64), status: 'cas_conflict' }],
  ])('rejects mismatched or conflicting plan restore output: %j', async output => {
    await expect(invokePlanExecute('health.plan.restore', {
      schemaVersion: 1, planId: 'daily-plan', expectedCurrentVersion: 4,
      restoreVersion: 3, restoreDigest: 'a'.repeat(64),
    }, output)).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION' })
  })

  it('fails closed when a successful executor result violates the output schema', async () => {
    const resolved = resolveFabricExecutor('health.source.sync', { environments: ['production'] })!
    const adapter: FabricExecutorAdapter = {
      id: 'health-source', type: 'connector',
      prepare: async () => result('prepared', { schemaVersion: 1 }),
      execute: async () => result('succeeded', { schemaVersion: 1, connectorId: 's400', syncId: 'sync-1',
        status: 'succeeded', recordIds: [], apiKey: 'must-not-pass' }),
      verify: async () => result('verified', { schemaVersion: 1 }),
      interrupt: async () => result('interrupted', {}),
      compensate: async () => result('unsupported', {}),
    }
    registerFabricExecutorAdapter(adapter)
    await expect(invokeFabricExecutor('execute', {
      intentId: 'intent-output', workflowId: 'workflow-output', stepId: 'step-output',
      executorId: resolved.executor.id, executorType: resolved.executor.type,
      capabilityId: resolved.capability.id, capabilityVersion: resolved.capability.version,
      contractDigest: resolved.capability.contractDigest, policyEvaluationToken: resolved.policyEvaluationToken,
      executionToken: 'output-token', input: request().input, target: request().target,
      now: '2026-07-14T00:00:00.000Z',
    })).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION' })
  })
})

function request() {
  return {
    capabilityId: 'health.source.sync', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
    idempotencyKey: 'source-sync', goal: 'sync configured source',
    target: { kind: 'health_connector', connectorId: 's400' },
    input: { schemaVersion: 1, connectorId: 's400', requestedAt: '2026-07-14T00:00:00.000Z' },
    constraints: {}, rationale: 'scheduled local ingestion', environments: ['production'] as Array<'production'>,
  }
}

function result(outcome: 'prepared' | 'succeeded' | 'verified' | 'interrupted' | 'unsupported', output: Record<string, unknown>) {
  return { outcome, output, evidence: [], errorCode: null, safeToRetry: false }
}

async function invokePlanExecute(capabilityId: 'health.plan.adjust' | 'health.plan.restore',
  input: Record<string, unknown>, output: Record<string, unknown>) {
  const resolved = resolveFabricExecutor(capabilityId, { environments: ['internal'] })!
  unregisterFabricExecutorAdapter('health-plan')
  registerFabricExecutorAdapter({
    id: 'health-plan', type: 'internal',
    prepare: async () => result('prepared', {}), execute: async () => result('succeeded', output),
    verify: async () => result('verified', {}), interrupt: async () => result('interrupted', {}),
    compensate: async () => result('unsupported', {}),
  })
  return invokeFabricExecutor('execute', {
    intentId: 'intent-plan', workflowId: 'workflow-plan', stepId: 'step-plan', executorId: 'health-plan',
    executorType: 'internal', capabilityId, capabilityVersion: resolved.capability.version,
    contractDigest: resolved.capability.contractDigest, policyEvaluationToken: resolved.policyEvaluationToken,
    executionToken: 'plan-token', input, target: { kind: 'health_plan', planId: 'daily-plan' },
    now: '2026-07-14T00:00:00.000Z',
  })
}
