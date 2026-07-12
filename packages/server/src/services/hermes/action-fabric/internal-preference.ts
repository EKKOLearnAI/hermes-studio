import { createHash } from 'crypto'
import {
  deleteTwinPreference,
  getTwinPreference,
  setTwinPreference,
  twinPreferenceExpectation,
  TWIN_DOMAINS,
  type TwinDomain,
  type TwinPreference,
  type TwinPreferenceExpectation,
} from '../personal-twin'
import { isFabricSensitiveString } from './audit'
import { withActionFabricDb } from './database'
import type {
  FabricCompensateResult,
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricInterruptResult,
  FabricPrepareResult,
  FabricVerifyResult,
} from './executors'
import type { FabricJsonObject } from './types'

const CAPABILITY_ID = 'internal.twin.preference.set'
const MAX_VALUE_BYTES = 8_192

interface PreferenceAddress { subjectId: string; domain: TwinDomain; key: string }
interface PreparedPreference extends PreferenceAddress {
  existed: boolean
  prior: { value: unknown; provenance: TwinPreference['provenance'] } | null
  expectedCurrent: TwinPreferenceExpectation
  operation?: 'restore' | 'delete'
}

export function createInternalPreferenceExecutorAdapter(): FabricExecutorAdapter {
  return {
    id: 'internal-twin',
    type: 'internal',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        requireCapability(context)
        const compensation = compensationParent(context.input)
        if (compensation) return prepared(context, loadParentPreparation(compensation, context))
        const address = parseAddress(context.input)
        assertNonSensitive(address.key, context.input.value)
        const prior = getTwinPreference(address.subjectId, address.domain, address.key)
        return prepared(context, {
          ...address, existed: prior !== null,
          prior: prior ? { value: prior.value, provenance: prior.provenance } : null,
          expectedCurrent: twinPreferenceExpectation(prior),
        })
      } catch (error) {
        return failure('failed', stablePrepareError(error))
      }
    },
    async execute(context): Promise<FabricExecuteResult> {
      try {
        requireCapability(context)
        const preparedState = parsePrepared(context.preparedOutput)
        assertCompensationContext(context, preparedState)
        let applied: TwinPreference | null = null
        if (preparedState.operation === 'delete') {
          deleteTwinPreference(preparedState.subjectId, preparedState.domain, preparedState.key,
            { ...actionOperation(context, 'compensate-delete'), expectedCurrent: preparedState.expectedCurrent })
        } else if (preparedState.operation === 'restore') {
          if (!preparedState.prior) throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
          applied = setTwinPreference({
            subjectId: preparedState.subjectId, domain: preparedState.domain, key: preparedState.key,
            value: preparedState.prior.value, source: preparedState.prior.provenance.source,
            sourceId: preparedState.prior.provenance.sourceId, actor: preparedState.prior.provenance.actor,
            confidence: preparedState.prior.provenance.confidence, operationId: sourceId(context, 'compensate-restore'),
            expectedCurrent: preparedState.expectedCurrent,
          })
        } else {
          const address = parseAddress(context.input)
          assertSameAddress(address, preparedState)
          assertNonSensitive(address.key, context.input.value)
          applied = setTwinPreference({ ...address, value: context.input.value, source: 'action-fabric',
            sourceId: sourceId(context, 'execute'), actor: 'action-fabric', confidence: 1,
            expectedCurrent: preparedState.expectedCurrent })
        }
        return succeeded(context, preparedState, applied)
      } catch (error) {
        if (error instanceof Error && ['TWIN_PREFERENCE_CONFLICT', 'TWIN_PREFERENCE_OPERATION_STALE',
          'TWIN_PREFERENCE_OPERATION_CONFLICT'].includes(error.message)) {
          return failure('permanent_failure', error.message)
        }
        if (isValidationError(error)) return failure('permanent_failure', stableExecuteError(error))
        return failure('temporary_failure', 'TWIN_PREFERENCE_WRITE_FAILED', true)
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      try {
        requireCapability(context)
        const preparedState = parsePrepared(context.preparedOutput)
        assertCompensationContext(context, preparedState)
        const current = getTwinPreference(preparedState.subjectId, preparedState.domain, preparedState.key)
        const matches = preparedState.operation === 'delete'
          ? current === null
          : preparedState.operation === 'restore'
            ? current !== null && preparedState.prior !== null
              && canonical(current.value) === canonical(preparedState.prior.value)
              && canonical(current.provenance) === canonical(preparedState.prior.provenance)
            : current !== null && canonical(current.value) === canonical(context.input.value)
              && current.provenance.source === 'action-fabric'
              && typeof context.executionOutput?.sourceId === 'string'
              && current.provenance.sourceId === context.executionOutput.sourceId
        return matches ? verified(context, preparedState) : failure('mismatch', 'TWIN_PREFERENCE_VERIFICATION_MISMATCH')
      } catch (error) {
        return isValidationError(error)
          ? failure('failed', stableVerifyError(error))
          : failure('unknown', 'TWIN_PREFERENCE_VERIFY_FAILED')
      }
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'TWIN_PREFERENCE_INTERRUPT_UNSUPPORTED')
    },
    async compensate(context): Promise<FabricCompensateResult> {
      try {
        requireCapability(context)
        const state = parsePrepared(context.preparedOutput)
        const expectedCurrent = executionExpectation(context.executionOutput)
        if (state.existed) {
          if (!state.prior) throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
          setTwinPreference({ subjectId: state.subjectId, domain: state.domain, key: state.key,
            value: state.prior.value, source: state.prior.provenance.source,
            sourceId: state.prior.provenance.sourceId, actor: state.prior.provenance.actor,
            confidence: state.prior.provenance.confidence, operationId: sourceId(context, 'compensate-restore'),
            expectedCurrent })
        } else {
          deleteTwinPreference(state.subjectId, state.domain, state.key,
            { ...actionOperation(context, 'compensate-delete'), expectedCurrent })
        }
        return { outcome: 'compensated', output: resultOutput(state, sourceId(context, 'compensate')),
          evidence: evidence(context, 'preference_compensated'), errorCode: null, safeToRetry: false }
      } catch (error) {
        return failure('unknown', error instanceof Error && ['TWIN_PREFERENCE_CONFLICT',
          'TWIN_PREFERENCE_OPERATION_STALE', 'TWIN_PREFERENCE_OPERATION_CONFLICT'].includes(error.message)
          ? error.message : 'TWIN_PREFERENCE_COMPENSATION_FAILED')
      }
    },
  }
}

function compensationParent(input: FabricJsonObject): string | null {
  const id = input.originalWorkflowId
  if (id === undefined) return null
  if (typeof id !== 'string' || !/^workflow-[a-z0-9-]{1,190}$/i.test(id)) throw new Error('TWIN_PREFERENCE_COMPENSATION_INVALID')
  return id
}

function loadParentPreparation(workflowId: string, context: FabricExecutionContext): PreparedPreference {
  return withActionFabricDb(db => {
    const row = db.prepare(`SELECT s.output_json,executed.output_json execution_output_json FROM fabric_steps s
      JOIN fabric_steps executed ON executed.workflow_id=s.workflow_id AND executed.kind='execute'
        AND executed.ordinal=1 AND executed.state='succeeded'
      JOIN fabric_workflows parent ON parent.id=s.workflow_id
      JOIN fabric_workflows child ON child.id=? AND child.intent_id=?
      WHERE s.workflow_id=? AND s.kind='prepare' AND s.ordinal=0 AND s.state='succeeded'
        AND parent.compensation_intent_id=?`).get(
      context.workflowId, context.intentId, workflowId, context.intentId,
    ) as
      { output_json: string | null; execution_output_json: string | null } | undefined
    if (!row?.output_json || !row.execution_output_json) throw new Error('TWIN_PREFERENCE_COMPENSATION_PARENT_UNAVAILABLE')
    const parent = parsePrepared(JSON.parse(row.output_json) as FabricJsonObject)
    return { ...parent, expectedCurrent: executionExpectation(JSON.parse(row.execution_output_json) as FabricJsonObject),
      operation: parent.existed ? 'restore' : 'delete' }
  })
}

function assertCompensationContext(context: FabricExecutionContext, state: PreparedPreference): void {
  const parent = compensationParent(context.input)
  if ((parent === null) !== (state.operation === undefined)) throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
}

function parseAddress(value: FabricJsonObject): PreferenceAddress {
  const subjectId = value.subjectId
  const domain = value.domain
  const key = value.key
  if (typeof subjectId !== 'string' || subjectId !== 'person:self'
    || typeof domain !== 'string' || !TWIN_DOMAINS.includes(domain as TwinDomain)
    || typeof key !== 'string' || key.length < 1 || key.length > 160 || !/^[a-z0-9][a-z0-9._-]*$/i.test(key)) {
    throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
  }
  return { subjectId, domain: domain as TwinDomain, key }
}

function parsePrepared(value: FabricJsonObject | undefined): PreparedPreference {
  if (!value) throw new Error('TWIN_PREFERENCE_PREPARATION_MISSING')
  const address = parseAddress(value)
  if (typeof value.existed !== 'boolean' || !(value.prior === null || isRecord(value.prior))) {
    throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  }
  const operation = value.operation
  const expectedCurrent = parseExpectation(value.expectedCurrent)
  if (!(operation === undefined || operation === 'restore' || operation === 'delete')) {
    throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  }
  let prior: PreparedPreference['prior'] = null
  if (value.prior !== null) {
    const provenance = value.prior.provenance
    if (!isRecord(provenance) || typeof provenance.source !== 'string' || typeof provenance.sourceId !== 'string'
      || typeof provenance.actor !== 'string' || typeof provenance.confidence !== 'number') {
      throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
    }
    assertNonSensitive(address.key, value.prior.value)
    prior = { value: value.prior.value, provenance: provenance as unknown as TwinPreference['provenance'] }
  }
  if (value.existed !== (prior !== null)) throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  return { ...address, existed: value.existed, prior, expectedCurrent, ...(operation ? { operation } : {}) }
}

function assertNonSensitive(key: string, value: unknown): void {
  if (/(?:password|passwd|secret|token|api.?key|credential|authorization|cookie|session|private.?key)/i.test(key)) {
    throw new Error('TWIN_PREFERENCE_SENSITIVE')
  }
  let bytes = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (nodes > 256 || depth > 6) throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8')
      if (isFabricSensitiveString(item)) throw new Error('TWIN_PREFERENCE_SENSITIVE')
      return
    }
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || item === null) throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
    if (Array.isArray(item)) { if (item.length > 64) throw new Error('TWIN_PREFERENCE_INPUT_INVALID'); item.forEach(v => visit(v, depth + 1)); return }
    if (!isRecord(item)) throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
    const keys = Object.keys(item)
    if (keys.length > 64) throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
    for (const childKey of keys) {
      if (/(?:password|secret|token|credential|authorization|cookie|session|private.?key)/i.test(childKey)) {
        throw new Error('TWIN_PREFERENCE_SENSITIVE')
      }
      bytes += Buffer.byteLength(childKey, 'utf8')
      visit(item[childKey], depth + 1)
    }
  }
  visit(value, 0)
  if (bytes > MAX_VALUE_BYTES || Buffer.byteLength(canonical(value), 'utf8') > MAX_VALUE_BYTES) {
    throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
  }
}

function assertSameAddress(left: PreferenceAddress, right: PreferenceAddress): void {
  if (left.subjectId !== right.subjectId || left.domain !== right.domain || left.key !== right.key) {
    throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  }
}

function requireCapability(context: FabricExecutionContext): void {
  if (context.capabilityId !== CAPABILITY_ID || context.executorId !== 'internal-twin' || context.executorType !== 'internal') {
    throw new Error('TWIN_PREFERENCE_BINDING_INVALID')
  }
}

function sourceId(context: FabricExecutionContext, phase: string): string {
  const material = canonical({ intentId: context.intentId, workflowId: context.workflowId,
    stepId: context.stepId, executionToken: context.executionToken, phase })
  return `fabric:${phase}:${createHash('sha256').update(material).digest('hex')}`
}

function actionOperation(context: FabricExecutionContext, phase: string) {
  return { source: 'action-fabric' as const, sourceId: sourceId(context, phase), actor: 'action-fabric' as const }
}

function prepared(context: FabricExecutionContext, output: PreparedPreference): FabricPrepareResult {
  return { outcome: 'prepared', output: output as unknown as FabricJsonObject,
    evidence: evidence(context, 'preference_prepared'), errorCode: null, safeToRetry: false }
}

function succeeded(context: FabricExecutionContext, state: PreparedPreference, applied: TwinPreference | null): FabricExecuteResult {
  const id = sourceId(context, state.operation ? `execute-${state.operation}` : 'execute')
  return { outcome: 'succeeded', output: { ...resultOutput(state, id),
    resultExpectation: twinPreferenceExpectation(applied) as unknown as FabricJsonObject },
  evidence: evidence(context, 'preference_written'),
    errorCode: null, safeToRetry: false }
}

function verified(context: FabricExecutionContext, state: PreparedPreference): FabricVerifyResult {
  return { outcome: 'verified', output: resultOutput(state, sourceId(context, 'verify')),
    evidence: evidence(context, 'preference_verified'), errorCode: null, safeToRetry: false }
}

function resultOutput(state: PreferenceAddress, sourceIdValue: string): FabricJsonObject {
  return { subjectId: state.subjectId, domain: state.domain, key: state.key, sourceId: sourceIdValue }
}

function parseExpectation(value: unknown): TwinPreferenceExpectation {
  if (!isRecord(value) || (value.state !== 'absent' && value.state !== 'present')) {
    throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  }
  if (value.state === 'absent') return { state: 'absent' }
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error('TWIN_PREFERENCE_PREPARATION_INVALID')
  }
  return { state: 'present', version: Number(value.version), digest: value.digest }
}

function executionExpectation(output: FabricJsonObject | undefined): TwinPreferenceExpectation {
  if (!output) throw new Error('TWIN_PREFERENCE_EXECUTION_RESULT_MISSING')
  return parseExpectation(output.resultExpectation)
}

function evidence(context: FabricExecutionContext, summary: string) {
  return [{ kind: 'internal_twin', summary, data: { capabilityId: CAPABILITY_ID,
    operationDigest: createHash('sha256').update(sourceId(context, summary)).digest('hex') },
  capturedAt: context.now ?? new Date().toISOString() }]
}

function failure<T extends 'failed' | 'temporary_failure' | 'permanent_failure' | 'unknown' | 'mismatch' | 'unsupported'>(
  outcome: T,
  errorCode: string,
  safeToRetry = false,
) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry }
}

function stablePrepareError(error: unknown): string {
  return error instanceof Error && error.message === 'TWIN_PREFERENCE_SENSITIVE'
    ? error.message : 'TWIN_PREFERENCE_PREPARE_FAILED'
}
function stableExecuteError(error: unknown): string {
  return error instanceof Error && /^TWIN_PREFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'TWIN_PREFERENCE_INPUT_INVALID'
}
function stableVerifyError(error: unknown): string {
  return error instanceof Error && /^TWIN_PREFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'TWIN_PREFERENCE_VERIFY_INVALID'
}
function isValidationError(error: unknown): boolean {
  return error instanceof Error && /^TWIN_PREFERENCE_(?:INPUT|SENSITIVE|PREPARATION|BINDING)/.test(error.message)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('TWIN_PREFERENCE_INPUT_INVALID')
  return encoded
}
