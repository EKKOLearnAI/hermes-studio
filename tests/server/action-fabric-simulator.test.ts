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

  it('rejects adapter replacement and unsupported real executor types', () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    expect(() => registerFabricExecutorAdapter(createSimulatorExecutorAdapter())).toThrow('FABRIC_EXECUTOR_ADAPTER_EXISTS')
    expect(() => registerFabricExecutorAdapter({ ...successfulAdapter({}), id: 'browser-main', type: 'browser' as never }))
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
