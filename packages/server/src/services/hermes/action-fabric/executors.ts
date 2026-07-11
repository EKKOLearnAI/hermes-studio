import type { FabricEvidence, FabricExecutorType, FabricJsonObject } from './types'
import { resolveFabricExecutor } from './registry'
import { isFabricSensitiveString } from './audit'

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
  readonly type: 'simulator' | 'internal'
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
const MAX_EVIDENCE = 16
const MAX_DEPTH = 6
const MAX_ITEMS = 64
const MAX_STRING = 2_000
const MAX_BYTES = 24_000
const REDACTED = '[REDACTED]'

export function registerFabricExecutorAdapter(adapter: FabricExecutorAdapter): void {
  if (adapter === null || typeof adapter !== 'object'
    || (adapter.type !== 'simulator' && adapter.type !== 'internal')) {
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
  const resolved = resolveFabricExecutor(context.capabilityId, { environments: ['simulator', 'internal'] })
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
  try {
    const raw = await adapter[phase](context) as unknown
    return sanitizeResult(phase, raw, context.now)
  } catch {
    return exceptionResult(phase, context.now)
  }
}

function sanitizeResult(phase: FabricExecutorPhase, raw: unknown, now?: string): FabricExecutorResult {
  if (!isPlainRecord(raw)) throw new Error('invalid result')
  const descriptor = Object.getOwnPropertyDescriptors(raw)
  const outcome = dataProperty(descriptor, 'outcome')
  if (typeof outcome !== 'string' || !PHASE_OUTCOMES[phase].has(outcome)) throw new Error('invalid outcome')
  const outputValue = dataProperty(descriptor, 'output')
  const output = isPlainRecord(outputValue) ? sanitizeObject(outputValue) : {}
  const evidenceValue = dataProperty(descriptor, 'evidence')
  const evidence = sanitizeEvidence(evidenceValue, now)
  const errorValue = dataProperty(descriptor, 'errorCode')
  const errorCode = typeof errorValue === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(errorValue) ? errorValue : null
  const retryValue = dataProperty(descriptor, 'safeToRetry')
  const safeToRetry = outcome === 'unknown' ? false : retryValue === true
  return { outcome, output, evidence, errorCode, safeToRetry } as FabricExecutorResult
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

function sanitizeEvidence(value: unknown, now?: string): FabricEvidence[] {
  if (!Array.isArray(value)) return []
  const entries: FabricEvidence[] = []
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const length = Math.min(value.length, MAX_EVIDENCE)
  for (let index = 0; index < length; index += 1) {
    const property = descriptors[String(index)]
    const item = property && 'value' in property ? property.value : undefined
    if (!isPlainRecord(item)) continue
    const descriptor = Object.getOwnPropertyDescriptors(item)
    const kind = safeText(dataProperty(descriptor, 'kind'), 'evidence')
    const summary = safeText(dataProperty(descriptor, 'summary'), 'Evidence captured')
    const data = dataProperty(descriptor, 'data')
    const capturedAt = dataProperty(descriptor, 'capturedAt')
    entries.push({
      kind, summary,
      data: isPlainRecord(data) ? sanitizeObject(data) : {},
      capturedAt: validTime(typeof capturedAt === 'string' ? capturedAt : now),
    })
  }
  return entries
}

function sanitizeObject(value: Record<string, unknown>): FabricJsonObject {
  const budget = { bytes: 0, nodes: 0 }
  const sanitized = sanitizeValue(value, 0, new Set(), budget)
  return isPlainRecord(sanitized) ? sanitized : { _truncated: true }
}

function sanitizeValue(value: unknown, depth: number, seen: Set<object>, budget: { bytes: number; nodes: number }): unknown {
  budget.nodes += 1
  if (budget.nodes > 512 || budget.bytes > MAX_BYTES) return { _truncated: true }
  if (typeof value === 'string') {
    if (isSensitiveString(value)) return REDACTED
    const limited = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    budget.bytes += Buffer.byteLength(limited, 'utf8')
    return budget.bytes > MAX_BYTES ? '[TRUNCATED]' : limited
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return REDACTED
  if (depth >= MAX_DEPTH) return { _truncated: true }
  if (seen.has(value)) return { _truncated: 'cycle' }
  if (!Array.isArray(value) && !isPlainRecord(value)) return REDACTED
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const length = Math.min(value.length, MAX_ITEMS)
      const output: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const property = descriptors[String(index)]
        output.push(property && 'value' in property
          ? sanitizeValue(property.value, depth + 1, seen, budget)
          : REDACTED)
      }
      if (value.length > MAX_ITEMS) output.push({ _truncated: true })
      return output
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const output: FabricJsonObject = {}
    for (const key of Object.keys(descriptors).sort().slice(0, MAX_ITEMS)) {
      budget.bytes += Buffer.byteLength(key, 'utf8')
      const property = descriptors[key]
      if (!property || !('value' in property) || isSensitiveKey(key)) output[key] = REDACTED
      else output[key] = sanitizeValue(property.value, depth + 1, seen, budget)
      if (budget.bytes > MAX_BYTES) { output._truncated = true; break }
    }
    if (Object.keys(descriptors).length > MAX_ITEMS) output._truncated = true
    return output
  } finally {
    seen.delete(value)
  }
}

function dataProperty(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key]
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  if (isSensitiveString(value)) return REDACTED
  return value.slice(0, 500)
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key|path)/i.test(key)
}

function isSensitiveString(value: string): boolean {
  return isFabricSensitiveString(value)
}

function validTime(value?: string): string {
  if (value) {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === value) return value
  }
  return new Date().toISOString()
}
