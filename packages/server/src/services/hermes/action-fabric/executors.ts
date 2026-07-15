import { isProxy } from 'node:util/types'
import type { FabricEvidence, FabricExecutorType, FabricJsonObject } from './types'
import { resolveFabricExecutor } from './registry'
import { isFabricSensitiveString } from './audit'
import { validateFabricSchema, validateHealthOutputSemantics } from './contracts'
import { validateHomeOutputSemantics } from '../home/fabric-contracts'

export type FabricExecutorPhase = 'prepare' | 'execute' | 'verify' | 'interrupt' | 'compensate'

export interface FabricExecutionContext {
  intentId: string
  workflowId: string
  stepId: string
  executorId: string
  executorType: FabricExecutorType
  capabilityId: string
  capabilityVersion: number
  contractDigest: string
  policyEvaluationToken: string
  executionToken: string
  input: FabricJsonObject
  target: FabricJsonObject
  preparedOutput?: FabricJsonObject
  executionOutput?: FabricJsonObject
  now?: string
}

interface FabricExecutorResultBase {
  output: FabricJsonObject
  evidence: FabricEvidence[]
  errorCode: string | null
  safeToRetry: boolean
}

export interface FabricPrepareResult extends FabricExecutorResultBase {
  outcome: 'prepared' | 'failed'
}

export interface FabricExecuteResult extends FabricExecutorResultBase {
  outcome: 'succeeded' | 'temporary_failure' | 'permanent_failure' | 'unknown'
}

export interface FabricVerifyResult extends FabricExecutorResultBase {
  outcome: 'verified' | 'mismatch' | 'failed' | 'unknown'
}

export interface FabricInterruptResult extends FabricExecutorResultBase {
  outcome: 'interrupted' | 'unsupported' | 'failed' | 'unknown'
}

export interface FabricCompensateResult extends FabricExecutorResultBase {
  outcome: 'compensated' | 'unsupported' | 'failed' | 'unknown'
}

export type FabricExecutorResult = FabricPrepareResult | FabricExecuteResult | FabricVerifyResult
  | FabricInterruptResult | FabricCompensateResult

export interface FabricExecutorAdapter {
  readonly id: string
  readonly type: FabricExecutorType
  prepare(context: FabricExecutionContext): Promise<FabricPrepareResult>
  execute(context: FabricExecutionContext): Promise<FabricExecuteResult>
  verify(context: FabricExecutionContext): Promise<FabricVerifyResult>
  interrupt(context: FabricExecutionContext): Promise<FabricInterruptResult>
  compensate(context: FabricExecutionContext): Promise<FabricCompensateResult>
}

const adapters = new Map<string, FabricExecutorAdapter>()
const PHASE_OUTCOMES: Record<FabricExecutorPhase, ReadonlySet<string>> = {
  prepare: new Set(['prepared', 'failed']),
  execute: new Set(['succeeded', 'temporary_failure', 'permanent_failure', 'unknown']),
  verify: new Set(['verified', 'mismatch', 'failed', 'unknown']),
  interrupt: new Set(['interrupted', 'unsupported', 'failed', 'unknown']),
  compensate: new Set(['compensated', 'unsupported', 'failed', 'unknown']),
}
const SUCCESS_OUTCOMES = new Set(['prepared', 'succeeded', 'verified', 'interrupted', 'compensated'])
const MAX_EVIDENCE = 16
const MAX_DEPTH = 6
const MAX_ITEMS = 64
const MAX_STRING = 2_000
const MAX_RESULT_BYTES = 24_000
const MAX_SANITIZED_BYTES = 22_000
const MAX_NODES = 512
const REDACTED = '[REDACTED]'

interface SanitizationBudget {
  bytes: number
  nodes: number
  truncated: boolean
}

export function registerFabricExecutorAdapter(adapter: FabricExecutorAdapter): void {
  if (adapter === null || typeof adapter !== 'object'
    || !['simulator', 'internal', 'connector', 'mcp', 'browser'].includes(adapter.type)) {
    throw new Error('FABRIC_EXECUTOR_TYPE_UNSUPPORTED')
  }
  if (typeof adapter.id !== 'string' || !adapter.id || adapter.id.length > 160) {
    throw new Error('FABRIC_EXECUTOR_ADAPTER_INVALID')
  }
  for (const phase of Object.keys(PHASE_OUTCOMES) as FabricExecutorPhase[]) {
    if (typeof adapter[phase] !== 'function') throw new Error('FABRIC_EXECUTOR_ADAPTER_INVALID')
  }
  if (adapters.has(adapter.id)) throw new Error('FABRIC_EXECUTOR_ADAPTER_EXISTS')
  adapters.set(adapter.id, adapter)
}

export function unregisterFabricExecutorAdapter(id: string): boolean {
  return adapters.delete(id)
}

export async function invokeFabricExecutor(
  phase: 'prepare', context: FabricExecutionContext,
): Promise<FabricPrepareResult>
export async function invokeFabricExecutor(
  phase: 'execute', context: FabricExecutionContext,
): Promise<FabricExecuteResult>
export async function invokeFabricExecutor(
  phase: 'verify', context: FabricExecutionContext,
): Promise<FabricVerifyResult>
export async function invokeFabricExecutor(
  phase: 'interrupt', context: FabricExecutionContext,
): Promise<FabricInterruptResult>
export async function invokeFabricExecutor(
  phase: 'compensate', context: FabricExecutionContext,
): Promise<FabricCompensateResult>
export async function invokeFabricExecutor(
  phase: FabricExecutorPhase, context: FabricExecutionContext,
): Promise<FabricExecutorResult> {
  const resolved = resolveFabricExecutor(context.capabilityId, {
    environments: ['simulator', 'internal', 'sandbox', 'production'], executorId: context.executorId,
  })
  if (!resolved
    || resolved.executor.id !== context.executorId
    || resolved.executor.type !== context.executorType
    || resolved.capability.version !== context.capabilityVersion
    || resolved.capability.contractDigest !== context.contractDigest
    || resolved.binding.executorId !== context.executorId
    || resolved.binding.capabilityId !== context.capabilityId
    || resolved.binding.capabilityVersion !== context.capabilityVersion
    || resolved.binding.contractDigest !== context.contractDigest) {
    throw new Error('FABRIC_EXECUTOR_BINDING_INVALID')
  }
  if (resolved.policyEvaluationToken !== context.policyEvaluationToken) {
    throw new Error('FABRIC_EXECUTOR_POLICY_STALE')
  }
  const adapter = adapters.get(context.executorId)
  if (!adapter || adapter.id !== resolved.executor.id || adapter.type !== resolved.executor.type) {
    throw new Error('FABRIC_EXECUTOR_ADAPTER_UNAVAILABLE')
  }
  let raw: unknown
  try {
    raw = await adapter[phase](context) as unknown
  } catch {
    return exceptionResult(phase, context.now)
  }
  try {
    const result = sanitizeResult(phase, raw, context.now)
    if (phase === 'execute' && result.outcome === 'succeeded'
      && (!validateFabricSchema(result.output, resolved.capability.outputSchema)
        || !validateHealthOutputSemantics(context.capabilityId, context.input, result.output)
        || !validateHomeOutputSemantics(context.capabilityId, context.input, result.output))) {
      return contractViolationResult(phase, context.now)
    }
    return result
  } catch {
    return contractViolationResult(phase, context.now)
  }
}

/**
 * Emergency interruption is bound to the adapter and contract captured by the
 * active workflow lease. A later registry promotion must not make an already
 * running side effect impossible to stop.
 */
export async function invokeCapturedFabricInterrupt(
  context: FabricExecutionContext,
): Promise<FabricInterruptResult> {
  const adapter = adapters.get(context.executorId)
  if (!adapter || adapter.id !== context.executorId || adapter.type !== context.executorType) {
    throw new Error('FABRIC_EXECUTOR_ADAPTER_UNAVAILABLE')
  }
  let raw: unknown
  try { raw = await adapter.interrupt(context) }
  catch { return exceptionResult('interrupt', context.now) as FabricInterruptResult }
  try { return sanitizeResult('interrupt', raw, context.now) as FabricInterruptResult }
  catch { return contractViolationResult('interrupt', context.now) as FabricInterruptResult }
}

function sanitizeResult(phase: FabricExecutorPhase, raw: unknown, now?: string): FabricExecutorResult {
  if (!isPlainRecord(raw)) throw new Error('invalid result')
  const outcome = dataProperty(raw, 'outcome')
  if (typeof outcome !== 'string' || !PHASE_OUTCOMES[phase].has(outcome)) throw new Error('invalid outcome')
  const budget = newBudget()
  const outputValue = dataProperty(raw, 'output')
  if (!isPlainRecord(outputValue)) throw new Error('invalid output')
  const output = sanitizeObject(outputValue, budget)
  const evidenceValue = dataProperty(raw, 'evidence')
  if (isProxyValue(evidenceValue) || !Array.isArray(evidenceValue)) throw new Error('invalid evidence')
  const evidence = sanitizeEvidence(evidenceValue, now, budget)
  const errorValue = dataProperty(raw, 'errorCode')
  const errorCode = typeof errorValue === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(errorValue) ? errorValue : null
  const retryValue = dataProperty(raw, 'safeToRetry')
  if (typeof retryValue !== 'boolean') throw new Error('invalid retry marker')
  const success = SUCCESS_OUTCOMES.has(outcome)
  if ((success && errorValue !== null) || (!success && errorCode === null)) throw new Error('invalid error code')
  const mayRetry = phase === 'execute' && outcome === 'temporary_failure'
  if (retryValue && !mayRetry) throw new Error('invalid retry combination')
  const safeToRetry = mayRetry && retryValue
  const result = { outcome, output, evidence, errorCode, safeToRetry } as FabricExecutorResult
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('result exceeds persisted JSON budget')
  }
  return result
}

function exceptionResult(phase: FabricExecutorPhase, now?: string): FabricExecutorResult {
  const outcome = phase === 'prepare' ? 'failed' : phase === 'execute' ? 'unknown'
    : phase === 'verify' ? 'unknown' : phase === 'interrupt' ? 'failed' : 'unknown'
  return {
    outcome, output: {}, evidence: [{
      kind: 'executor_error', summary: 'Executor invocation failed', data: {}, capturedAt: validTime(now),
    }], errorCode: 'FABRIC_EXECUTOR_EXCEPTION', safeToRetry: false,
  } as FabricExecutorResult
}

function contractViolationResult(phase: FabricExecutorPhase, now?: string): FabricExecutorResult {
  const outcome = phase === 'prepare' ? 'failed' : phase === 'execute' ? 'unknown'
    : phase === 'verify' ? 'unknown' : phase === 'interrupt' ? 'failed' : 'unknown'
  return {
    outcome, output: {}, evidence: [{
      kind: 'executor_contract', summary: 'Executor returned an invalid result', data: {}, capturedAt: validTime(now),
    }], errorCode: 'FABRIC_EXECUTOR_CONTRACT_VIOLATION', safeToRetry: false,
  } as FabricExecutorResult
}

function sanitizeEvidence(value: unknown, now: string | undefined, budget: SanitizationBudget): FabricEvidence[] {
  if (isProxyValue(value) || !Array.isArray(value)) return []
  if (budget.truncated || budget.nodes >= MAX_NODES || budget.bytes >= MAX_SANITIZED_BYTES) {
    return [truncationEvidence(now)]
  }
  const entries: FabricEvidence[] = []
  const length = Math.min(value.length, MAX_EVIDENCE)
  for (let index = 0; index < length; index += 1) {
    budget.nodes += 1
    if (budget.nodes > MAX_NODES) { budget.truncated = true; break }
    charge(budget, 96)
    const property = Object.getOwnPropertyDescriptor(value, String(index))
    const item = property && 'value' in property ? property.value : undefined
    if (!isPlainRecord(item)) continue
    const kind = safeText(dataProperty(item, 'kind'), 'evidence', budget)
    const summary = safeText(dataProperty(item, 'summary'), 'Evidence captured', budget)
    const data = dataProperty(item, 'data')
    const capturedAt = dataProperty(item, 'capturedAt')
    const timestamp = validTime(typeof capturedAt === 'string' ? capturedAt : now)
    charge(budget, Buffer.byteLength(timestamp, 'utf8'))
    entries.push({
      kind, summary,
      data: isPlainRecord(data) ? sanitizeObject(data, budget) : {},
      capturedAt: timestamp,
    })
    if (budget.truncated) break
  }
  if (value.length > MAX_EVIDENCE) budget.truncated = true
  if (budget.truncated) markEvidenceTruncated(entries, now)
  while (Buffer.byteLength(JSON.stringify(entries), 'utf8') > MAX_RESULT_BYTES && entries.length > 1) {
    entries.pop()
    markEvidenceTruncated(entries, now)
  }
  if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > MAX_RESULT_BYTES) {
    return [truncationEvidence(now)]
  }
  return entries
}

function sanitizeObject(value: Record<string, unknown>, budget: SanitizationBudget): FabricJsonObject {
  const sanitized = sanitizeValue(value, 0, new Set(), budget)
  return isPlainRecord(sanitized) ? sanitized : { _truncated: true }
}

function sanitizeValue(value: unknown, depth: number, seen: Set<object>, budget: SanitizationBudget): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_NODES || budget.bytes > MAX_SANITIZED_BYTES) {
    budget.truncated = true
    return { _truncated: true }
  }
  if (typeof value === 'string') {
    if (isSensitiveString(value)) return REDACTED
    const limited = truncateUtf8(value, Math.min(MAX_STRING, Math.max(0, MAX_SANITIZED_BYTES - budget.bytes)))
    charge(budget, Buffer.byteLength(limited, 'utf8'))
    if (limited !== value) budget.truncated = true
    return limited || '[TRUNCATED]'
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return REDACTED
  if (isProxyValue(value)) return REDACTED
  if (depth >= MAX_DEPTH) return { _truncated: true }
  if (seen.has(value)) return { _truncated: 'cycle' }
  if (!Array.isArray(value) && !isPlainRecord(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_ITEMS)
      const output: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(value, String(index))
        output.push(property && 'value' in property
          ? sanitizeValue(property.value, depth + 1, seen, budget)
          : REDACTED)
      }
      if (value.length > MAX_ITEMS) { output.push({ _truncated: true }); budget.truncated = true }
      return output
    }
    const output: FabricJsonObject = {}
    const keys = boundedEnumerableKeys(value)
    for (const key of keys.values) {
      charge(budget, Buffer.byteLength(key, 'utf8'))
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (!property || !('value' in property) || isSensitiveKey(key)) output[key] = REDACTED
      else output[key] = sanitizeValue(property.value, depth + 1, seen, budget)
      if (budget.bytes > MAX_SANITIZED_BYTES) { output._truncated = true; budget.truncated = true; break }
    }
    if (keys.truncated) { output._truncated = true; budget.truncated = true }
    return output
  } finally {
    seen.delete(value)
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxyValue(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeText(value: unknown, fallback: string, budget: SanitizationBudget): string {
  const source = typeof value === 'string' && value.trim() ? value : fallback
  const sanitized = isSensitiveString(source) ? REDACTED : truncateUtf8(source, 500)
  charge(budget, Buffer.byteLength(sanitized, 'utf8'))
  if (sanitized !== source) budget.truncated = true
  return sanitized
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key|path)/i.test(key)
}

function isSensitiveString(value: string): boolean {
  return isFabricSensitiveString(value)
}

function boundedEnumerableKeys(value: Record<string, unknown>): { values: string[]; truncated: boolean } {
  const values: string[] = []
  let truncated = false
  // Symbols and non-enumerable properties are intentionally excluded from persisted JSON evidence.
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (values.length >= MAX_ITEMS) { truncated = true; break }
    values.push(key)
  }
  values.sort()
  return { values, truncated }
}

function isProxyValue(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && isProxy(value)
}

function newBudget(): SanitizationBudget {
  return { bytes: 0, nodes: 0, truncated: false }
}

function charge(budget: SanitizationBudget, bytes: number): void {
  budget.bytes += bytes
  if (budget.bytes > MAX_SANITIZED_BYTES) budget.truncated = true
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function markEvidenceTruncated(entries: FabricEvidence[], now?: string): void {
  if (entries.length === 0) { entries.push(truncationEvidence(now)); return }
  entries[entries.length - 1]!.data._truncated = true
}

function truncationEvidence(now?: string): FabricEvidence {
  return {
    kind: 'evidence', summary: 'Evidence truncated', data: { _truncated: true }, capturedAt: validTime(now),
  }
}

function validTime(value?: string): string {
  if (value) {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === value) return value
  }
  return new Date().toISOString()
}
