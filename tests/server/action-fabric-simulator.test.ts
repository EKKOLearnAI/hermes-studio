import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createSimulatorExecutorAdapter,
  ensureBuiltInFabricRegistry,
  invokeFabricExecutor,
  registerFabricExecutorAdapter,
  resolveFabricExecutor,
  setFabricExecutorEnabled,
  unregisterFabricExecutorAdapter,
  updateFabricCapability,
  updateFabricExecutor,
  updateFabricExecutorHealth,
  type FabricExecutionContext,
  type FabricExecutorAdapter,
} from '../../packages/server/src/services/hermes/action-fabric'

describe('Action Fabric simulator executors', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-simulator-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    unregisterFabricExecutorAdapter('simulator-main')
  })

  afterEach(() => {
    unregisterFabricExecutorAdapter('simulator-main')
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('implements every executor phase with deterministic echo output', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const context = executionContext('simulator.echo', 'echo-token', { z: 1, message: 'hello' })

    await expect(invokeFabricExecutor('prepare', context)).resolves.toMatchObject({ outcome: 'prepared' })
    const first = await invokeFabricExecutor('execute', context)
    const second = await invokeFabricExecutor('execute', context)
    expect(first).toMatchObject({ outcome: 'succeeded', output: { message: 'hello', z: 1 } })
    expect(second).toEqual(first)
    await expect(invokeFabricExecutor('verify', { ...context, executionOutput: first.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    await expect(invokeFabricExecutor('interrupt', context)).resolves.toMatchObject({ outcome: 'interrupted' })
    await expect(invokeFabricExecutor('compensate', context)).resolves.toMatchObject({ outcome: 'unsupported' })
  })

  it('increments counters once per execution token even under concurrent duplicate calls', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const firstContext = executionContext('simulator.counter.increment', 'counter-token', { counter: 'jobs', amount: 2 })
    const [left, right] = await Promise.all([
      invokeFabricExecutor('execute', firstContext),
      invokeFabricExecutor('execute', firstContext),
    ])
    expect(left).toEqual(right)
    expect(left).toMatchObject({ outcome: 'succeeded', output: { counter: 'jobs', value: 2 } })

    const next = await invokeFabricExecutor(
      'execute', executionContext('simulator.counter.increment', 'counter-token-2', { counter: 'jobs', amount: 3 }),
    )
    expect(next).toMatchObject({ output: { counter: 'jobs', value: 5 } })

    // Simulator token state is deliberately process-local. Recreating the adapter models a process restart.
    unregisterFabricExecutorAdapter('simulator-main')
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    await expect(invokeFabricExecutor('execute', firstContext))
      .resolves.toMatchObject({ output: { counter: 'jobs', value: 2 } })
  })

  it('binds an execution token to capability and canonical material input', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const original = executionContext('simulator.counter.increment', 'bound-token', { counter: 'jobs', amount: 2 })
    await expect(invokeFabricExecutor('execute', original)).resolves.toMatchObject({ output: { value: 2 } })
    await expect(invokeFabricExecutor('execute', { ...original, input: { amount: 2, counter: 'jobs' } }))
      .resolves.toMatchObject({ outcome: 'succeeded', output: { value: 2 } })

    await expect(invokeFabricExecutor('execute', { ...original, input: { amount: 9, counter: 'jobs' } }))
      .resolves.toMatchObject({
        outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_TOKEN_MATERIAL_CONFLICT', safeToRetry: false,
      })
    await expect(invokeFabricExecutor('execute', executionContext('simulator.echo', 'bound-token', { amount: 2 })))
      .resolves.toMatchObject({ outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_TOKEN_MATERIAL_CONFLICT' })
    await expect(invokeFabricExecutor('execute', { ...original, preparedOutput: { checkpoint: 'changed' } }))
      .resolves.toMatchObject({ outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_TOKEN_MATERIAL_CONFLICT' })
    await expect(invokeFabricExecutor('execute', original)).resolves.toMatchObject({ output: { value: 2 } })
  })

  it('clears retryable temporary outcomes but preserves single-flight execution', async () => {
    let attempts = 0
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({
      faultFor: (_context, phase) => phase === 'execute' && attempts++ === 0 ? 'temporary_failure' : null,
    }))
    const context = executionContext('simulator.echo', 'recoverable-token', { message: 'recover' })
    const firstPair = await Promise.all([
      invokeFabricExecutor('execute', context), invokeFabricExecutor('execute', context),
    ])
    expect(firstPair).toEqual([
      expect.objectContaining({ outcome: 'temporary_failure', safeToRetry: true }),
      expect.objectContaining({ outcome: 'temporary_failure', safeToRetry: true }),
    ])
    await expect(invokeFabricExecutor('execute', { ...context, input: { message: 'different' } }))
      .resolves.toMatchObject({
        outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_TOKEN_MATERIAL_CONFLICT', safeToRetry: false,
      })
    await expect(invokeFabricExecutor('execute', context))
      .resolves.toMatchObject({ outcome: 'succeeded', output: { message: 'recover' } })
    expect(attempts).toBe(2)
  })

  it('counts retry tombstones toward the hard token capacity', async () => {
    let first = true
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({
      maxExecutionTokens: 1,
      faultFor: () => first ? (first = false, 'temporary_failure') : null,
    }))
    const context = executionContext('simulator.echo', 'tombstone-one', { message: 'retry' })
    await expect(invokeFabricExecutor('execute', context))
      .resolves.toMatchObject({ outcome: 'temporary_failure', safeToRetry: true })
    await expect(invokeFabricExecutor('execute', { ...context, executionToken: 'tombstone-two' }))
      .resolves.toMatchObject({ outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_CACHE_FULL' })
    await expect(invokeFabricExecutor('execute', context))
      .resolves.toMatchObject({ outcome: 'succeeded', output: { message: 'retry' } })
  })

  it('normalizes a rejected execution promise to a cached unknown outcome', async () => {
    let attempts = 0
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({
      faultFor: () => { attempts += 1; throw new Error('raw provider failure') },
    }))
    const context = executionContext('simulator.echo', 'rejected-token', { message: 'unknown' })
    const first = await invokeFabricExecutor('execute', context)
    const replay = await invokeFabricExecutor('execute', context)
    expect(first).toMatchObject({
      outcome: 'unknown', errorCode: 'SIMULATOR_EXECUTION_EXCEPTION', safeToRetry: false,
    })
    expect(replay).toEqual(first)
    expect(attempts).toBe(1)
  })

  it('fails closed at the token cache bound without evicting completed side effects', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({ maxExecutionTokens: 1 }))
    const first = executionContext('simulator.counter.increment', 'capacity-one', { counter: 'jobs', amount: 1 })
    await expect(invokeFabricExecutor('execute', first)).resolves.toMatchObject({ output: { value: 1 } })
    await expect(invokeFabricExecutor('execute', { ...first, executionToken: 'capacity-two' }))
      .resolves.toMatchObject({
        outcome: 'permanent_failure', errorCode: 'SIMULATOR_EXECUTION_CACHE_FULL', safeToRetry: false,
      })
    await expect(invokeFabricExecutor('execute', first)).resolves.toMatchObject({ output: { value: 1 } })
  })

  it.each([
    ['temporary_failure', 'temporary_failure', true],
    ['permanent_failure', 'permanent_failure', false],
    ['unknown', 'unknown', false],
  ] as const)('injects %s as a stable execute outcome', async (fault, outcome, safeToRetry) => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({ faultFor: (_context, phase) => phase === 'execute' ? fault : null }))
    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', `fault-${fault}`, {}))
    expect(result).toMatchObject({ outcome, safeToRetry, errorCode: `SIMULATOR_${fault.toUpperCase()}` })
  })

  it('injects verification mismatch and compensation failure fixtures', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter({
      faultFor: (_context, phase) => phase === 'verify' ? 'verification_mismatch'
        : phase === 'compensate' ? 'compensation_failure' : null,
    }))
    const context = executionContext('simulator.echo', 'phase-faults', {})
    await expect(invokeFabricExecutor('verify', context)).resolves.toMatchObject({
      outcome: 'mismatch', safeToRetry: false, errorCode: 'SIMULATOR_VERIFICATION_MISMATCH',
    })
    await expect(invokeFabricExecutor('compensate', context)).resolves.toMatchObject({
      outcome: 'failed', safeToRetry: false, errorCode: 'SIMULATOR_COMPENSATION_FAILURE',
    })
  })

  it('converts raw exceptions to stable sanitized outcomes', async () => {
    registerFabricExecutorAdapter(throwingAdapter())
    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'throws', {}))

    expect(result).toMatchObject({ outcome: 'unknown', safeToRetry: false, errorCode: 'FABRIC_EXECUTOR_EXCEPTION' })
    expect(JSON.stringify(result)).not.toContain('hunter2')
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\Alice')
  })

  it.each([
    ['prepare', { outcome: 'succeeded', errorCode: null, safeToRetry: false }],
    ['execute', { outcome: 'succeeded', errorCode: 'SHOULD_NOT_SURVIVE', safeToRetry: false }],
    ['verify', { outcome: 'verified', errorCode: null, safeToRetry: true }],
    ['interrupt', { outcome: 'failed', errorCode: null, safeToRetry: false }],
    ['compensate', { outcome: 'compensated', errorCode: null, safeToRetry: true }],
  ] as const)('normalizes invalid %s adapter result combinations to contract violation', async (phase, invalid) => {
    registerFabricExecutorAdapter(adapterWithRawPhaseResult(phase, invalid))
    const result = await (invokeFabricExecutor as (
      selectedPhase: typeof phase, context: FabricExecutionContext,
    ) => Promise<{ errorCode: string | null; safeToRetry: boolean; evidence: unknown[] }>)(
      phase, executionContext('simulator.echo', `invalid-${phase}`, {}),
    )
    expect(result).toMatchObject({
      errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION', safeToRetry: false,
    })
    expect(result.evidence).toEqual([expect.objectContaining({
      kind: 'executor_contract', summary: 'Executor returned an invalid result', data: {},
    })])
    expect(JSON.stringify(result)).not.toContain('SHOULD_NOT_SURVIVE')
  })

  it('permits retry only for execute temporary failures', async () => {
    registerFabricExecutorAdapter(adapterWithRawPhaseResult('execute', {
      outcome: 'temporary_failure', errorCode: 'SIMULATOR_TEMPORARY_FAILURE', safeToRetry: true,
    }))
    await expect(invokeFabricExecutor('execute', executionContext('simulator.echo', 'valid-retry', {})))
      .resolves.toMatchObject({
        outcome: 'temporary_failure', errorCode: 'SIMULATOR_TEMPORARY_FAILURE', safeToRetry: true,
      })
  })

  it('bounds hostile evidence without invoking accessors and redacts secrets and paths', async () => {
    let getterCalls = 0
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const hostileArray: unknown[] = []
    Object.defineProperty(hostileArray, '0', {
      enumerable: true, configurable: true, get: () => { getterCalls += 1; return 'stolen' },
    })
    hostileArray.length = 1
    const hostile = Object.defineProperty({
      password: 'hunter2', path: 'C:\\Users\\Alice\\secret.txt', cycle,
      hostileArray,
      deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } },
      huge: 'x'.repeat(100_000),
    }, 'stolen', { enumerable: true, get: () => { getterCalls += 1; return 'secret' } })
    const adapter = successfulAdapter(hostile)
    registerFabricExecutorAdapter(adapter)

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'hostile', {}))
    const encoded = JSON.stringify(result)
    expect(result.outcome).toBe('succeeded')
    expect(getterCalls).toBe(0)
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(32_768)
    expect(encoded).not.toContain('hunter2')
    expect(encoded).not.toContain('C:\\\\Users')
    expect(encoded).toContain('[REDACTED]')
    expect(encoded).toContain('_truncated')
  })

  it('redacts credential values and sensitive paths even under neutral keys and nested arrays', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'
    registerFabricExecutorAdapter(successfulAdapter({
      samples: [
        'sk-proj-abcdefghijklmnop', jwt, '\\\\server\\share\\private.txt',
        'file:///home/alice/private.txt', '/home/alice/private.txt', 'Bearer abcdefghijklmnop',
        '-----BEGIN PRIVATE KEY-----',
        ['ordinary', { value: 'sk-proj-qrstuvwxyzabcdef' }, [jwt, '\\\\server\\share\\nested.txt']],
      ],
      ordinary: 'The simulator completed normally',
      apiRoute: '/api/action-fabric/workflows',
    }))

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'secret-values', {}))
    expect(result.evidence[0]?.data).toEqual({
      apiRoute: '/api/action-fabric/workflows',
      ordinary: 'The simulator completed normally',
      samples: [
        '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]',
        ['ordinary', { value: '[REDACTED]' }, ['[REDACTED]', '[REDACTED]']],
      ],
    })
  })

  it('shares one UTF-8 evidence budget across kind, summary, and every evidence data object', async () => {
    const adapter = successfulAdapter({})
    const evidence = Array.from({ length: 16 }, (_, index) => ({
      kind: `kind-${index}-${'界'.repeat(400)}`,
      summary: `summary-${index}-${'界'.repeat(600)}`,
      data: { value: `data-${index}-${'界'.repeat(1_500)}` },
    }))
    adapter.execute = async () => ({ outcome: 'succeeded', output: {}, evidence, errorCode: null, safeToRetry: false })
    registerFabricExecutorAdapter(adapter)

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'evidence-budget', {}))
    expect(result.outcome).toBe('succeeded')
    expect(Buffer.byteLength(JSON.stringify(result.evidence), 'utf8')).toBeLessThanOrEqual(24_000)
    expect(JSON.stringify(result.evidence)).toContain('_truncated')
  })

  it('shares one result budget across large output and evidence', async () => {
    const adapter = successfulAdapter(Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`evidence-${index}`, 'e'.repeat(2_000)]),
    ))
    adapter.execute = async () => ({
      outcome: 'succeeded',
      output: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`output-${index}`, 'o'.repeat(2_000)])),
      evidence: [{ kind: 'combined', summary: 'combined', data: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`evidence-${index}`, 'e'.repeat(2_000)]),
      ) }],
      errorCode: null, safeToRetry: false,
    })
    registerFabricExecutorAdapter(adapter)

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'combined-budget', {}))
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(24_000)
    expect(JSON.stringify(result)).not.toContain('e'.repeat(2_000))
  })

  it('hard-checks final JSON bytes including quote and backslash escaping overhead', async () => {
    const adapter = successfulAdapter({})
    adapter.execute = async () => ({
      outcome: 'succeeded',
      output: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
        `escaped-${index}`, `${'\\'.repeat(200)}${'"'.repeat(100)}`,
      ])),
      evidence: [], errorCode: null, safeToRetry: false,
    })
    registerFabricExecutorAdapter(adapter)

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'escaped-budget', {}))
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(24_000)
    expect(result).toMatchObject({
      outcome: 'unknown', errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION', safeToRetry: false,
    })
  })

  it('shares the node budget between output and evidence without visiting excess evidence nodes', async () => {
    const adapter = successfulAdapter({})
    const output = { groups: Array.from({ length: 64 }, (_, group) => ({
      group, values: Array.from({ length: 7 }, (_, value) => ({ value })),
    })) }
    adapter.execute = async () => ({
      outcome: 'succeeded', output,
      evidence: [{ kind: 'late', summary: 'late', data: { marker: 'EVIDENCE_SHOULD_NOT_SURVIVE' } }],
      errorCode: null, safeToRetry: false,
    })
    registerFabricExecutorAdapter(adapter)

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'shared-nodes', {}))
    expect(JSON.stringify(result)).not.toContain('EVIDENCE_SHOULD_NOT_SURVIVE')
    expect(JSON.stringify(result)).toContain('_truncated')
  })

  it('rejects proxy evidence before traps and bounds huge enumerable objects without reading accessors', async () => {
    let proxyTraps = 0
    const proxy = new Proxy({}, {
      ownKeys: () => { proxyTraps += 1; return ['secret'] },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; return { enumerable: true, configurable: true, value: 'leak' } },
    })
    let getterCalls = 0
    const huge: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) huge[`key-${index}`] = index
    Object.defineProperty(huge, 'hidden', { value: 'not-enumerable', enumerable: false })
    Object.defineProperty(huge, 'getter', { enumerable: true, get: () => { getterCalls += 1; return 'leak' } })
    registerFabricExecutorAdapter(successfulAdapter({ proxy, huge }))

    const result = await invokeFabricExecutor('execute', executionContext('simulator.echo', 'bounded-object', {}))
    expect(proxyTraps).toBe(0)
    expect(getterCalls).toBe(0)
    expect(result.evidence[0]?.data.proxy).toBe('[REDACTED]')
    const bounded = result.evidence[0]?.data.huge as Record<string, unknown>
    expect(Object.keys(bounded).length).toBeLessThanOrEqual(65)
    expect(bounded).toHaveProperty('_truncated', true)
    expect(bounded).not.toHaveProperty('hidden')
  })

  it('rejects adapter replacement and accepts governed external executor types', () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    expect(() => registerFabricExecutorAdapter(createSimulatorExecutorAdapter())).toThrow('FABRIC_EXECUTOR_ADAPTER_EXISTS')
    registerFabricExecutorAdapter({ ...successfulAdapter({}), id: 'browser-main', type: 'browser' })
    registerFabricExecutorAdapter({ ...successfulAdapter({}), id: 'mcp-main', type: 'mcp' })
    registerFabricExecutorAdapter({ ...successfulAdapter({}), id: 'android-main', type: 'android' })
    expect(() => registerFabricExecutorAdapter({ ...successfulAdapter({}), id: 'unknown-main', type: 'unknown' as never }))
      .toThrow('FABRIC_EXECUTOR_TYPE_UNSUPPORTED')
  })

  it('revalidates stored executor identity, type, health, binding version and policy token before every invocation', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const valid = executionContext('simulator.echo', 'boundary', {})
    await expect(invokeFabricExecutor('execute', valid)).resolves.toMatchObject({ outcome: 'succeeded' })

    await expect(invokeFabricExecutor('execute', { ...valid, executorId: 'wrong-id' }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
    await expect(invokeFabricExecutor('execute', { ...valid, executorType: 'internal' }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
    await expect(invokeFabricExecutor('execute', { ...valid, capabilityVersion: 99 }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
    await expect(invokeFabricExecutor('execute', { ...valid, policyEvaluationToken: 'stale' }))
      .rejects.toThrow('FABRIC_EXECUTOR_POLICY_STALE')

    setFabricExecutorEnabled('simulator-main', false)
    await expect(invokeFabricExecutor('execute', valid)).rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
    setFabricExecutorEnabled('simulator-main', true)
    updateFabricExecutorHealth('simulator-main', 'unhealthy', {})
    await expect(invokeFabricExecutor('execute', { ...valid, executionToken: 'unhealthy' }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
  })

  it('rejects stale bindings and stored executor type changes instead of trusting the adapter map', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const context = executionContext('simulator.echo', 'registry-mutation', {})
    updateFabricCapability('simulator.echo', { version: 2, description: 'Echo version two' })
    await expect(invokeFabricExecutor('execute', context)).rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')

    updateFabricExecutor('simulator-main', { type: 'internal', environment: 'internal' })
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    await expect(invokeFabricExecutor('execute', { ...context, executorType: 'internal', capabilityVersion: 2 }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
  })

  function executionContext(capabilityId: string, executionToken: string, input: Record<string, unknown>): FabricExecutionContext {
    const resolved = resolveFabricExecutor(capabilityId, { environments: ['simulator'] })
    if (!resolved) throw new Error(`Missing resolved executor for ${capabilityId}`)
    return {
      intentId: 'intent-test', workflowId: 'workflow-test', stepId: 'step-test',
      executorId: resolved.executor.id, executorType: resolved.executor.type,
      capabilityId, capabilityVersion: resolved.capability.version,
      contractDigest: resolved.capability.contractDigest,
      policyEvaluationToken: resolved.policyEvaluationToken,
      executionToken, input, target: { id: 'simulator' },
    }
  }
})

function successfulAdapter(evidenceData: Record<string, unknown>): FabricExecutorAdapter {
  const result = async () => ({
    outcome: 'succeeded' as const, output: {}, evidence: [{ kind: 'test', summary: 'ok', data: evidenceData }],
    errorCode: null, safeToRetry: false,
  })
  return {
    id: 'simulator-main', type: 'simulator',
    prepare: async () => ({ ...(await result()), outcome: 'prepared' }),
    execute: result,
    verify: async () => ({ ...(await result()), outcome: 'verified' }),
    interrupt: async () => ({ ...(await result()), outcome: 'interrupted' }),
    compensate: async () => ({ ...(await result()), outcome: 'compensated' }),
  }
}

function throwingAdapter(): FabricExecutorAdapter {
  const adapter = successfulAdapter({})
  return { ...adapter, execute: async () => { throw new Error('password=hunter2 at C:\\Users\\Alice\\secret.txt') } }
}

function adapterWithRawPhaseResult(
  phase: 'prepare' | 'execute' | 'verify' | 'interrupt' | 'compensate',
  result: { outcome: string; errorCode: string | null; safeToRetry: boolean },
): FabricExecutorAdapter {
  const adapter = successfulAdapter({}) as unknown as Record<string, unknown>
  adapter[phase] = async () => ({ ...result, output: {}, evidence: [{
    kind: 'raw', summary: 'invalid SHOULD_NOT_SURVIVE', data: { raw: 'SHOULD_NOT_SURVIVE' },
  }] })
  return adapter as unknown as FabricExecutorAdapter
}
