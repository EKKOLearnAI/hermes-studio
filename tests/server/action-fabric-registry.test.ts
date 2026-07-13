import { mkdtempSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindFabricExecutorCapability,
  createFabricCapability,
  createFabricExecutor,
  ensureBuiltInFabricRegistry,
  getActionFabricDbPath,
  getFabricCapability,
  listFabricCapabilities,
  listFabricExecutors,
  resolveFabricExecutor,
  setFabricExecutorEnabled,
  updateFabricCapability,
  updateFabricExecutor,
  updateFabricExecutorHealth,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'

const capability = (overrides: Record<string, unknown> = {}) => ({
  id: 'custom.notes.append',
  version: 1,
  description: 'Append a note',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  risk: 'low' as const,
  sideEffect: true,
  idempotency: 'required' as const,
  reversible: false,
  compensationCapabilityId: null,
  verificationStrategy: 'read_after_write',
  authentication: [],
  targetRestrictions: [],
  cost: { currency: null, estimatedMinor: 0 },
  enabled: true,
  ...overrides,
})

const codeUnitCanonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(codeUnitCanonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${codeUnitCanonicalize(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

describe('action fabric registry', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-fabric-registry-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('preserves the Phase 3 capability contract digests while extending the built-in registry', () => {
    ensureBuiltInFabricRegistry()

    expect(listFabricCapabilities().filter(item => !item.id.startsWith('health.')).map(item => [item.id, item.contractDigest])).toEqual([
      ['internal.twin.preference.set', 'dbdbf09d1e81e330cd0381e0ec5a12a4d56dd2d0b290c1fe65383af9e794ab09'],
      ['simulator.counter.increment', '3146a84ee07c62677ee6e608668c0c71f8b99b1cbecd81d546437f188f71a50e'],
      ['simulator.echo', '1f74a0c7fc1a997a22425d365107379fb88effdc49cc91c68fd34a174082ff79'],
    ])
    expect(listFabricExecutors().filter(item => !item.id.startsWith('health-')).map(item => [item.id, item.type, item.environment, item.configuration.externalWrite])).toEqual([
      ['internal-twin', 'internal', 'internal', false],
      ['simulator-main', 'simulator', 'simulator', false],
    ])
    expect(withActionFabricDb(db => db.prepare(`
      SELECT executor_id, capability_id, capability_version
      FROM fabric_executor_capabilities WHERE capability_id NOT LIKE 'health.%' ORDER BY capability_id
    `).all())).toEqual([
      expect.objectContaining({ executor_id: 'internal-twin', capability_id: 'internal.twin.preference.set', capability_version: 1 }),
      expect.objectContaining({ executor_id: 'simulator-main', capability_id: 'simulator.counter.increment', capability_version: 1 }),
      expect.objectContaining({ executor_id: 'simulator-main', capability_id: 'simulator.echo', capability_version: 1 }),
    ])
  })

  it('reseed is idempotent and never overwrites operator edits or runtime state', () => {
    ensureBuiltInFabricRegistry()
    updateFabricCapability('simulator.echo', { version: 2, description: 'Operator description', enabled: false })
    setFabricExecutorEnabled('simulator-main', false)
    updateFabricExecutorHealth('simulator-main', 'degraded', { reason: 'maintenance' })

    ensureBuiltInFabricRegistry()

    expect(getFabricCapability('simulator.echo')).toMatchObject({ description: 'Operator description', enabled: false })
    expect(listFabricExecutors().find(item => item.id === 'simulator-main')).toMatchObject({
      enabled: false,
      health: 'degraded',
      healthDetails: { reason: 'maintenance' },
    })
    expect(withActionFabricDb(db => db.prepare("SELECT COUNT(*) AS count FROM fabric_executor_capabilities WHERE capability_id NOT LIKE 'health.%'").get()))
      .toEqual({ count: 3 })
  })

  it('uses a read-only fast path and preserves stale bindings for explicit rebind', () => {
    ensureBuiltInFabricRegistry()
    const writer = new DatabaseSync(getActionFabricDbPath())
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('BEGIN IMMEDIATE')
    try {
      expect(() => ensureBuiltInFabricRegistry()).not.toThrow()
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }

    withActionFabricDb(db => db.prepare(`UPDATE fabric_executor_capabilities
      SET contract_digest='stale' WHERE capability_id='simulator.echo'`).run())
    ensureBuiltInFabricRegistry()
    expect(withActionFabricDb(db => db.prepare(`SELECT b.contract_digest = c.contract_digest AS matches
      FROM fabric_executor_capabilities b JOIN fabric_capabilities c ON c.id=b.capability_id
      WHERE b.capability_id='simulator.echo'`).get())).toEqual({ matches: 0 })
  })

  it.each(['mcp', 'browser'])('rejects unsupported executor type %s from create and update APIs', type => {
    expect(() => createFabricExecutor({
      id: `${type}-main`, type, name: type, environment: 'sandbox', configuration: { externalWrite: false }, enabled: true,
    } as never)).toThrow(/unsupported executor type/i)

    ensureBuiltInFabricRegistry()
    expect(() => updateFabricExecutor('simulator-main', { type } as never)).toThrow(/unsupported executor type/i)
  })

  it('accepts connector executors with explicit external-write classification', () => {
    const executor = createFabricExecutor({
      id: 'connector-main', type: 'connector', name: 'Connector', environment: 'production',
      configuration: { externalWrite: true, interruptible: true }, enabled: true,
    })
    expect(executor).toMatchObject({ type: 'connector', environment: 'production', configuration: { externalWrite: true } })
    expect(() => createFabricExecutor({
      id: 'connector-unclassified', type: 'connector', name: 'Unclassified connector',
      environment: 'production', configuration: {}, enabled: true,
    })).toThrow(/explicitly classify externalWrite/i)
    expect(() => updateFabricExecutor('connector-main', { configuration: {} }))
      .toThrow(/explicitly classify externalWrite/i)
  })

  it.each([
    ['malformed semantic id', { id: 'BadId' }],
    ['array input schema', { inputSchema: [] }],
    ['non-object output schema', { outputSchema: 'object' }],
    ['invalid risk', { risk: 'extreme' }],
    ['negative cost', { cost: { currency: 'USD', estimatedMinor: -1 } }],
    ['unpaired cost currency', { cost: { currency: null, estimatedMinor: 1 } }],
    ['missing verification', { verificationStrategy: '' }],
    ['compensation on irreversible capability', { compensationCapabilityId: 'custom.notes.undo' }],
    ['missing compensation on reversible capability', { reversible: true }],
    ['oversized description', { description: 'x'.repeat(2001) }],
    ['oversized schema JSON', { inputSchema: { value: 'x'.repeat(33_000) } }],
    ['oversized authentication array', { authentication: Array.from({ length: 65 }, (_, i) => `auth-${i}`) }],
  ])('rejects invalid capability: %s', (_label, overrides) => {
    expect(() => createFabricCapability(capability(overrides) as never)).toThrow(/invalid|must|too large|unsupported/i)
  })

  it('prevents silent semantic changes at the same capability version', () => {
    createFabricCapability(capability())
    expect(() => createFabricCapability(capability({ description: 'Different contract' }))).toThrow(/contract.*version/i)
  })

  it('requires a binding contract version and digest that match the capability', () => {
    ensureBuiltInFabricRegistry()
    createFabricExecutor({
      id: 'simulator-secondary', type: 'simulator', name: 'Secondary', environment: 'simulator',
      configuration: { externalWrite: false }, enabled: true,
    })
    const echo = getFabricCapability('simulator.echo')!

    expect(() => bindFabricExecutorCapability('simulator-secondary', echo.id, 2, echo.contractDigest))
      .toThrow(/version.*match/i)
    expect(() => bindFabricExecutorCapability('simulator-secondary', echo.id, 1, 'wrong'))
      .toThrow(/digest.*match/i)
  })

  it('resolves deterministically to an enabled healthy executor in a permitted environment', () => {
    ensureBuiltInFabricRegistry()
    createFabricExecutor({
      id: 'aaa-simulator', type: 'simulator', name: 'Preferred', environment: 'simulator',
      configuration: { externalWrite: false }, enabled: true,
    })
    updateFabricExecutorHealth('aaa-simulator', 'healthy', {})
    const echo = getFabricCapability('simulator.echo')!
    bindFabricExecutorCapability('aaa-simulator', echo.id, echo.version, echo.contractDigest)

    expect(resolveFabricExecutor(echo.id, { environments: ['internal'] })).toBeNull()
    expect(resolveFabricExecutor(echo.id, { environments: ['simulator'] })?.executor.id).toBe('aaa-simulator')
    setFabricExecutorEnabled('aaa-simulator', false)
    expect(resolveFabricExecutor(echo.id, { environments: ['simulator'] })?.executor.id).toBe('simulator-main')
  })

  it('pins semantic changes to a new version and requires an explicit matching rebind', () => {
    ensureBuiltInFabricRegistry()
    const first = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!

    expect(() => updateFabricCapability('simulator.echo', { risk: 'medium' })).toThrow(/version.*increase/i)
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })?.policyEvaluationToken)
      .toBe(first.policyEvaluationToken)

    const updated = updateFabricCapability('simulator.echo', { version: 2, risk: 'medium' })
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })).toBeNull()
    expect(withActionFabricDb(db => db.prepare(`SELECT capability_version, contract_digest
      FROM fabric_executor_capabilities WHERE executor_id='simulator-main' AND capability_id='simulator.echo'`).get()))
      .toEqual({ capability_version: 1, contract_digest: first.binding.contractDigest })

    ensureBuiltInFabricRegistry()
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })).toBeNull()
    bindFabricExecutorCapability('simulator-main', updated.id, updated.version, updated.contractDigest)
    const rebound = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!
    expect(rebound.policyEvaluationToken).not.toBe(first.policyEvaluationToken)
  })

  it('allows operational toggles without a contract version bump', () => {
    ensureBuiltInFabricRegistry()
    const before = getFabricCapability('simulator.echo')!
    const disabled = updateFabricCapability('simulator.echo', { enabled: false })

    expect(disabled).toMatchObject({ version: before.version, contractDigest: before.contractDigest, enabled: false })
  })

  it.each([
    ['undefined', { value: undefined }],
    ['function', { value: () => undefined }],
    ['symbol', { value: Symbol('unsafe') }],
    ['bigint', { value: BigInt(1) }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['non-plain object', { value: new Date() }],
    ['dangerous key', JSON.parse('{"__proto__":{"polluted":true}}')],
  ])('rejects unsafe recursive schema JSON: %s', (_label, inputSchema) => {
    expect(() => createFabricCapability(capability({ inputSchema }) as never)).toThrow(/invalid.*json|unsafe|plain|finite|cycle/i)
  })

  it('rejects cycles, symbol keys, and unsafe executor JSON payloads', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const symbolKey = { type: 'object' } as Record<PropertyKey, unknown>
    symbolKey[Symbol('unsafe')] = true

    expect(() => createFabricCapability(capability({ outputSchema: cyclic }) as never)).toThrow(/cycle/i)
    expect(() => createFabricCapability(capability({ inputSchema: symbolKey }) as never)).toThrow(/unsafe|symbol/i)
    expect(() => createFabricExecutor({
      id: 'unsafe-simulator', type: 'simulator', name: 'Unsafe', environment: 'simulator',
      configuration: { value: undefined }, enabled: true,
    } as never)).toThrow(/invalid.*json|unsafe/i)
  })

  it('normalizes legacy-compatible executor input to an explicit persisted classification', () => {
    const missing = createFabricExecutor({
      id: 'internal-missing-scope', type: 'internal', name: 'Missing scope', environment: 'internal',
      configuration: {}, enabled: true,
    })
    const malformed = createFabricExecutor({
      id: 'internal-invalid-scope', type: 'internal', name: 'Invalid scope', environment: 'internal',
      configuration: { externalWrite: 'false' }, enabled: true,
    } as never)
    const simulator = createFabricExecutor({
      id: 'simulator-compatible', type: 'simulator', name: 'Simulator', environment: 'simulator',
      configuration: {}, enabled: true,
    })
    expect([missing.configuration.externalWrite, malformed.configuration.externalWrite,
      simulator.configuration.externalWrite]).toEqual([true, true, false])
  })

  it('safely backfills legacy built-in classification without changing explicit operator scope', () => {
    ensureBuiltInFabricRegistry()
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_executors SET configuration_json='{}' WHERE id='simulator-main'").run()
      db.prepare(`UPDATE fabric_executors SET configuration_json='{"externalWrite":true}'
        WHERE id='internal-twin'`).run()
      db.prepare(`INSERT INTO fabric_executors(id,type,name,environment,health,health_details_json,
        configuration_json,enabled,policy_version,created_at,updated_at)
        VALUES('legacy-internal','internal','Legacy','internal','healthy','{}','{}',1,1,?,?)`).run(
        new Date().toISOString(), new Date().toISOString(),
      )
    })
    ensureBuiltInFabricRegistry()
    const executors = listFabricExecutors()
    expect(executors.find(item => item.id === 'simulator-main')?.configuration.externalWrite).toBe(false)
    expect(executors.find(item => item.id === 'internal-twin')?.configuration.externalWrite).toBe(true)
    expect(executors.find(item => item.id === 'legacy-internal')?.configuration.externalWrite).toBe(true)
  })

  it('rejects non-enumerable array entries before canonicalization', () => {
    const inputSchema: unknown[] = [{ type: 'string' }]
    Object.defineProperty(inputSchema, '0', { value: inputSchema[0], enumerable: false })

    expect(() => createFabricCapability(capability({ inputSchema: { anyOf: inputSchema } }) as never))
      .toThrow(/enumerable/i)
  })

  it.each([
    ['leading-zero index', '01'],
    ['negative-zero index', '-0'],
    ['out-of-range index', '2'],
    ['maximum non-index integer', '4294967295'],
    ['extra string key', 'metadata'],
  ])('rejects array own key that JSON.stringify drops: %s', (_label, key) => {
    const inputSchema = key === '2'
      ? new Proxy([], {
          ownKeys: () => ['length', '2'],
          getOwnPropertyDescriptor: (target, property) => property === '2'
            ? { value: true, writable: true, enumerable: true, configurable: true }
            : Reflect.getOwnPropertyDescriptor(target, property),
        })
      : Object.defineProperty([], key, { value: true, enumerable: true, configurable: true })
    expect(JSON.stringify(inputSchema)).toBe('[]')

    expect(() => createFabricCapability(capability({ inputSchema: { anyOf: inputSchema } }) as never))
      .toThrow(/array.*key|canonical/i)
  })

  it('rejects symbol array keys that JSON.stringify drops', () => {
    const inputSchema = Object.defineProperty([], Symbol('metadata'), { value: true, enumerable: true })
    expect(JSON.stringify(inputSchema)).toBe('[]')

    expect(() => createFabricCapability(capability({ inputSchema: { anyOf: inputSchema } }) as never))
      .toThrow(/array.*key|symbol|canonical/i)
  })

  it('changes the policy token after an executor environment change', () => {
    ensureBuiltInFabricRegistry()
    const first = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!

    updateFabricExecutor('simulator-main', { environment: 'internal' })
    const second = resolveFabricExecutor('simulator.echo', { environments: ['internal'] })!
    expect(second.policyEvaluationToken).not.toBe(first.policyEvaluationToken)

  })

  it('monotonically invalidates policy tokens across disable-enable cycles', () => {
    ensureBuiltInFabricRegistry()
    const first = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!

    updateFabricCapability('simulator.echo', { enabled: false })
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })).toBeNull()
    updateFabricCapability('simulator.echo', { enabled: true })
    const second = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!

    expect(second.policyRevision).toBeGreaterThan(first.policyRevision)
    expect(second.policyEvaluationToken).not.toBe(first.policyEvaluationToken)
    expect(withActionFabricDb(db => db.prepare(
      "SELECT value FROM fabric_meta WHERE key='registry_policy_revision'",
    ).get())).toEqual({ value: String(second.policyRevision) })
  })

  it('uses locale-independent UTF-16 key ordering in contract digests', () => {
    const input = capability({
      id: 'custom.unicode.order',
      inputSchema: { 中: 5, é: 4, a: 3, _: 2, Z: 1, '!': 0 },
    })
    const { enabled: _enabled, ...contract } = input
    const expected = createHash('sha256').update(codeUnitCanonicalize(contract)).digest('hex')

    expect(createFabricCapability(input).contractDigest).toBe(expected)
  })

  it('validates, bounds, deduplicates, and preserves caller environment priority', () => {
    ensureBuiltInFabricRegistry()
    expect(() => resolveFabricExecutor('simulator.echo', { environments: [] })).toThrow(/environment.*empty|at least one/i)
    expect(() => resolveFabricExecutor('simulator.echo', { environments: 'simulator' } as never)).toThrow(/environment.*array/i)
    expect(() => resolveFabricExecutor('simulator.echo', { environments: ['simulator', 'simulator', 'internal', 'sandbox', 'production'] }))
      .toThrow(/environment.*four|too many/i)
    expect(() => resolveFabricExecutor('simulator.echo', { environments: ['invalid'] as never })).toThrow(/invalid.*environment/i)

    const echo = getFabricCapability('simulator.echo')!
    bindFabricExecutorCapability('internal-twin', echo.id, echo.version, echo.contractDigest)
    const internalFirst = resolveFabricExecutor('simulator.echo', { environments: ['internal', 'simulator'] })!
    const simulatorFirst = resolveFabricExecutor('simulator.echo', { environments: ['simulator', 'internal', 'simulator'] })!
    expect(internalFirst.executor.id).toBe('internal-twin')
    expect(simulatorFirst.executor.id).toBe('simulator-main')
  })

  it('reads the complete resolution and policy revision from one atomic registry statement', () => {
    ensureBuiltInFabricRegistry()
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      const resolved = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })
      expect(resolved).not.toBeNull()

      const resolutionReads = prepare.mock.calls.map(([sql]) => String(sql)).filter(sql =>
        /\bSELECT\b/i.test(sql)
        && /(FROM|JOIN)\s+fabric_(capabilities|executors|executor_capabilities)\b/i.test(sql),
      )
      expect(resolutionReads).toHaveLength(1)
      expect(resolutionReads[0]).toMatch(/fabric_capabilities/)
      expect(resolutionReads[0]).toMatch(/fabric_executor_capabilities/)
      expect(resolutionReads[0]).toMatch(/fabric_executors/)
      expect(resolutionReads[0]).toMatch(/fabric_meta/)
    } finally {
      prepare.mockRestore()
    }
  })
})
