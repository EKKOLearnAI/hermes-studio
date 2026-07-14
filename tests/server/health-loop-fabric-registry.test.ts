import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureBuiltInFabricRegistry,
  getFabricCapability,
  invokeFabricExecutor,
  listFabricCapabilities,
  listFabricExecutors,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  withActionFabricDb,
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
      const expectedVersion = ['health.reminder.send', 'health.artifact.analyze.remote'].includes(capability.id) ? 2 : 1
      expect(capability.version).toBe(expectedVersion)
      expect(capability.idempotency).toBe('required')
      expect(capability.targetRestrictions.length).toBeGreaterThan(0)
      const payloadSchemaVersion = capability.id === 'health.reminder.send' ? 2 : 1
      expect(capability.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['schemaVersion']),
        properties: expect.objectContaining({ schemaVersion: { const: payloadSchemaVersion } }),
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
      targetRestrictions: ['health:artifact', 'health:processor'],
    })
    expect(remote.outputSchema).toMatchObject({ properties: {
      processorReceiptId: { type: ['string', 'null'] }, verificationStatus: { enum: ['verified', 'unverifiable'] },
    } })
    expect(remote.inputSchema).toMatchObject({
      properties: expect.objectContaining({ consentId: expect.any(Object), manifestDigest: expect.any(Object), processorId: expect.any(Object) }),
      required: expect.arrayContaining(['consentId', 'manifestDigest', 'processorId']),
    })
    expect((remote.inputSchema.properties as Record<string, unknown>).oneTimeConsentToken).toBeUndefined()
    expect(capabilities.find(item => item.id === 'health.reminder.send')).toMatchObject({
      version: 2,
      risk: 'low',
      sideEffect: true,
      authentication: ['live_mode:enabled', 'recipient:configured_self'],
      targetRestrictions: ['health:recipient'],
    })
    const reminderProperties = (capabilities.find(item => item.id === 'health.reminder.send')!.inputSchema.properties
      ?? {}) as Record<string, unknown>
    expect(reminderProperties.messageText).toBeUndefined()
    expect(withActionFabricDb(db => db.prepare(`SELECT version,contract_json,contract_digest
      FROM fabric_capability_contract_history WHERE capability_id='health.reminder.send' ORDER BY version`).all()))
      .toEqual([
        expect.objectContaining({ version: 1, contract_json: expect.stringContaining('messageText'),
          contract_digest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ version: 2, contract_json: expect.not.stringContaining('messageText'),
          contract_digest: capabilities.find(item => item.id === 'health.reminder.send')!.contractDigest }),
      ])
    expect(capabilities.find(item => item.id === 'health.plan.adjust')).toMatchObject({
      risk: 'low', reversible: true, compensationCapabilityId: 'health.plan.restore',
      verificationStrategy: 'plan_version_read_after_write',
    })
    expect(capabilities.find(item => item.id === 'health.plan.restore')).toMatchObject({
      reversible: false, compensationCapabilityId: null, verificationStrategy: 'plan_version_compare_and_set',
    })
    for (const id of ['health.source.sync', 'health.artifact.analyze.local', 'health.artifact.analyze.remote']) {
      const output = capabilities.find(item => item.id === id)!.outputSchema as { properties: Record<string, any> }
      const ids = output.properties.recordIds ?? output.properties.observationIds
      expect(ids.maxItems).toBe(64)
      expect(output.properties).toMatchObject({
        totalCount: { type: 'integer', minimum: 0 }, omittedCount: { type: 'integer', minimum: 0 },
        continuationCursor: { type: ['string', 'null'], maxLength: 2048 },
      })
    }
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
    expect(executors.filter(item => ['health-plan', 'health-source'].includes(item.id))
      .map(item => [item.id, item.configuration.interruptible])).toEqual([
      ['health-plan', false], ['health-source', false],
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

  it('migrates the known transitional reminder v1 to v2 while preserving canonical Task10 v1 history', () => {
    ensureBuiltInFabricRegistry()
    const current = getFabricCapability('health.reminder.send')!
    const transitionalInput = structuredClone(current.inputSchema) as { properties: Record<string, { const?: number }> }
    transitionalInput.properties.schemaVersion = { const: 1 }
    const transitional = capabilityContract(current, 1, transitionalInput)
    const transitionalDigest = contractDigest(transitional)
    withActionFabricDb(db => {
      db.exec(`DROP TABLE fabric_capability_contract_history;
        UPDATE fabric_meta SET value='4' WHERE key='schema_version';`)
      db.prepare(`UPDATE fabric_capabilities SET version=1,input_schema_json=?,contract_digest=?
        WHERE id='health.reminder.send'`).run(JSON.stringify(transitionalInput), transitionalDigest)
      db.prepare(`UPDATE fabric_executor_capabilities SET capability_version=1,contract_digest=?
        WHERE capability_id='health.reminder.send'`).run(transitionalDigest)
    })

    expect(() => ensureBuiltInFabricRegistry()).not.toThrow()
    expect(getFabricCapability('health.reminder.send')).toMatchObject({ version: 2 })
    const history = withActionFabricDb(db => db.prepare(`SELECT version,contract_json,contract_digest
      FROM fabric_capability_contract_history WHERE capability_id='health.reminder.send' ORDER BY version`).all()) as Array<{
        version: number; contract_json: string; contract_digest: string
      }>
    expect(history.map(item => item.version)).toEqual([1, 2])
    const v1 = JSON.parse(history[0].contract_json) as { inputSchema: { required: string[]; properties: Record<string, unknown> } }
    expect(v1.inputSchema.required).toContain('messageText')
    expect(v1.inputSchema.properties).toHaveProperty('messageText')
    expect(history[1].contract_digest).toBe(getFabricCapability('health.reminder.send')!.contractDigest)
  })

  it('fails closed instead of promoting an unknown same-version reminder digest', () => {
    ensureBuiltInFabricRegistry()
    withActionFabricDb(db => {
      db.exec(`DROP TABLE fabric_capability_contract_history;
        UPDATE fabric_meta SET value='4' WHERE key='schema_version';`)
      db.prepare(`UPDATE fabric_capabilities SET version=1,contract_digest=?
        WHERE id='health.reminder.send'`).run('f'.repeat(64))
      db.prepare(`UPDATE fabric_executor_capabilities SET capability_version=1,contract_digest=?
        WHERE capability_id='health.reminder.send'`).run('f'.repeat(64))
    })
    expect(() => ensureBuiltInFabricRegistry()).toThrow(/reminder.*digest|contract.*unknown/i)
    const row = withActionFabricDb(db => db.prepare(
      "SELECT version,contract_digest FROM fabric_capabilities WHERE id='health.reminder.send'",
    ).get())
    expect(row).toEqual({ version: 1, contract_digest: 'f'.repeat(64) })
  })

  it('stops a captured reminder v1 at the stale-contract boundary before transport', async () => {
    ensureBuiltInFabricRegistry()
    const v1 = withActionFabricDb(db => db.prepare(`SELECT contract_digest FROM fabric_capability_contract_history
      WHERE capability_id='health.reminder.send' AND version=1`).get()) as { contract_digest: string }
    const execute = vi.fn()
    const unsupported = vi.fn(async () => ({ outcome: 'unsupported' as const, output: {}, evidence: [],
      errorCode: 'unsupported', safeToRetry: false }))
    registerFabricExecutorAdapter({ id: 'health-weixin', type: 'connector', prepare: unsupported, execute,
      verify: unsupported, interrupt: unsupported, compensate: unsupported } as unknown as FabricExecutorAdapter)
    const resolved = resolveFabricExecutor('health.reminder.send', { environments: ['production'] })!
    await expect(invokeFabricExecutor('execute', {
      intentId: 'intent-v1', workflowId: 'workflow-v1', stepId: 'step-v1', executorId: 'health-weixin',
      executorType: 'connector', capabilityId: 'health.reminder.send', capabilityVersion: 1,
      contractDigest: v1.contract_digest, policyEvaluationToken: resolved.policyEvaluationToken,
      executionToken: 'execution-v1', input: { schemaVersion: 1, actionId: 'legacy-action',
        recipient: 'configured-self', messageCode: 'legacy', messageText: 'arbitrary legacy text' },
      target: { kind: 'health_recipient', recipient: 'configured-self' }, now: '2026-07-14T00:00:00.000Z',
    })).rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
    expect(execute).not.toHaveBeenCalled()
  })
})

function capabilityContract(current: NonNullable<ReturnType<typeof getFabricCapability>>,
  version: number, inputSchema: Record<string, unknown>) {
  return { id: current.id, version, description: current.description, inputSchema, outputSchema: current.outputSchema,
    risk: current.risk, sideEffect: current.sideEffect, idempotency: current.idempotency, reversible: current.reversible,
    compensationCapabilityId: current.compensationCapabilityId, verificationStrategy: current.verificationStrategy,
    authentication: current.authentication, targetRestrictions: current.targetRestrictions, cost: current.cost }
}

function contractDigest(input: object): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}
