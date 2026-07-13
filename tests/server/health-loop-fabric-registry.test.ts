import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureBuiltInFabricRegistry,
  invokeFabricExecutor,
  listFabricCapabilities,
  listFabricExecutors,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  type FabricExecutorAdapter,
} from '../../packages/server/src/services/hermes/action-fabric'

const HEALTH_CAPABILITIES = [
  'health.artifact.analyze.local',
  'health.artifact.analyze.remote',
  'health.checkin.request',
  'health.followup.schedule',
  'health.plan.adjust',
  'health.plan.restore',
  'health.reminder.send',
  'health.source.sync',
] as const

describe('health Action Fabric registry', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-fabric-registry-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    for (const id of ['health-shadow', 'health-source', 'health-local-analysis', 'health-remote-analysis', 'health-plan', 'health-weixin']) {
      unregisterFabricExecutorAdapter(id)
    }
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('registers eight versioned, explicit health contracts with safety metadata', () => {
    ensureBuiltInFabricRegistry()

    const capabilities = listFabricCapabilities().filter(item => item.domain === 'health')
    expect(capabilities.map(item => item.id)).toEqual(HEALTH_CAPABILITIES)
    for (const capability of capabilities) {
      expect(capability.version).toBe(1)
      expect(capability.idempotency).toBe('required')
      expect(capability.targetRestrictions.length).toBeGreaterThan(0)
      expect(capability.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['schemaVersion']),
        properties: expect.objectContaining({ schemaVersion: { const: 1 } }),
      })
      expect(capability.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['schemaVersion']),
      })
      expect(capability.inputSchema).not.toEqual({ type: 'object' })
    }

    const remote = capabilities.find(item => item.id === 'health.artifact.analyze.remote')!
    expect(remote).toMatchObject({
      risk: 'medium',
      sideEffect: true,
      authentication: ['one_time_consent:exact_artifact_manifest', 'processor:exact_id'],
      targetRestrictions: ['artifact:exact_manifest', 'processor:exact_id'],
    })
    expect(remote.inputSchema).toMatchObject({
      properties: expect.objectContaining({ consentId: expect.any(Object), manifestDigest: expect.any(Object), processorId: expect.any(Object) }),
      required: expect.arrayContaining(['consentId', 'manifestDigest', 'processorId']),
    })
    expect((remote.inputSchema.properties as Record<string, unknown>).oneTimeConsentToken).toBeUndefined()
    expect(capabilities.find(item => item.id === 'health.reminder.send')).toMatchObject({
      risk: 'low',
      sideEffect: true,
      authentication: ['live_mode:enabled', 'recipient:configured_self'],
      targetRestrictions: ['recipient:configured_self'],
    })
    expect(capabilities.find(item => item.id === 'health.plan.adjust')).toMatchObject({
      risk: 'low', reversible: true, compensationCapabilityId: 'health.plan.restore',
      verificationStrategy: 'plan_version_read_after_write',
    })
    expect(capabilities.find(item => item.id === 'health.plan.restore')).toMatchObject({
      reversible: false, compensationCapabilityId: null, verificationStrategy: 'plan_version_compare_and_set',
    })
  })

  it('classifies every health executor and resolves shadow, internal, and live bindings exactly', () => {
    ensureBuiltInFabricRegistry()

    const executors = listFabricExecutors().filter(item => item.id.startsWith('health-'))
    expect(executors.map(item => [item.id, item.type, item.environment, item.configuration.externalWrite])).toEqual([
      ['health-local-analysis', 'internal', 'internal', false],
      ['health-plan', 'internal', 'internal', false],
      ['health-remote-analysis', 'connector', 'production', true],
      ['health-shadow', 'connector', 'sandbox', false],
      ['health-source', 'connector', 'production', false],
      ['health-weixin', 'connector', 'production', true],
    ])
    expect(resolveFabricExecutor('health.plan.adjust', { environments: ['internal'] })?.executor.id).toBe('health-plan')
    expect(resolveFabricExecutor('health.plan.adjust', { environments: ['sandbox'] })?.executor.id).toBe('health-shadow')
    expect(resolveFabricExecutor('health.artifact.analyze.remote', { environments: ['production'] })?.executor.id)
      .toBe('health-remote-analysis')
    expect(resolveFabricExecutor('health.reminder.send', { environments: ['production'] })?.executor.id).toBe('health-weixin')
    expect(resolveFabricExecutor('health.source.sync', { environments: ['production'] })?.executor.id).toBe('health-source')
  })

  it('accepts a connector adapter and invokes it only through its exact durable binding', async () => {
    ensureBuiltInFabricRegistry()
    const resolved = resolveFabricExecutor('health.source.sync', { environments: ['production'] })!
    const adapter: FabricExecutorAdapter = {
      id: 'health-source',
      type: 'connector',
      prepare: async () => ({ outcome: 'prepared', output: { schemaVersion: 1 }, evidence: [], errorCode: null, safeToRetry: false }),
      execute: async () => ({ outcome: 'succeeded', output: { schemaVersion: 1 }, evidence: [], errorCode: null, safeToRetry: false }),
      verify: async () => ({ outcome: 'verified', output: { schemaVersion: 1 }, evidence: [], errorCode: null, safeToRetry: false }),
      interrupt: async () => ({ outcome: 'interrupted', output: {}, evidence: [], errorCode: null, safeToRetry: false }),
      compensate: async () => ({ outcome: 'unsupported', output: {}, evidence: [], errorCode: 'FABRIC_COMPENSATION_UNSUPPORTED', safeToRetry: false }),
    }
    registerFabricExecutorAdapter(adapter)

    await expect(invokeFabricExecutor('prepare', {
      intentId: 'intent-health-source', workflowId: 'workflow-health-source', stepId: 'step-health-source',
      executorId: resolved.executor.id, executorType: resolved.executor.type,
      capabilityId: resolved.capability.id, capabilityVersion: resolved.capability.version,
      contractDigest: resolved.capability.contractDigest, policyEvaluationToken: resolved.policyEvaluationToken,
      executionToken: 'health-source-token', input: { schemaVersion: 1, connectorId: 's400' },
      target: { connectorId: 's400' }, now: '2026-07-14T00:00:00.000Z',
    })).resolves.toMatchObject({ outcome: 'prepared', output: { schemaVersion: 1 } })
  })
})
