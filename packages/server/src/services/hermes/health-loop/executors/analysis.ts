import { createHash } from 'crypto'
import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'
import { isFabricSensitiveString } from '../../action-fabric/audit'
import type { HealthConsentBroker } from '../consent'
import { validateHealthAnalysisResult, type HealthAnalysisResult } from '../analysis'
import type { AuxiliaryVisionAnalyzer } from '../analyzers/auxiliary-vision'
import {
  AUTHORIZED_AUXILIARY_ANALYZE, consumeHealthReservation, readHealthReservationAuthorization,
  type HealthReservationAuthorization,
} from './reservation-internal'

const DIGEST = /^[a-f0-9]{64}$/
const MAX_RESULT_BYTES = 512 * 1024

export interface HealthAnalysisArtifactIdentity { artifactId: string; manifestDigest: string }
export interface HealthAnalysisArtifactResolver {
  resolve(artifactId: string): Promise<HealthAnalysisArtifactIdentity | null>
}
export interface HealthAnalysisConsentRequest extends HealthAnalysisArtifactIdentity { consentId: string; processorId: string }
export interface HealthAnalysisConsentConsumer {
  consume(request: HealthAnalysisConsentRequest): Promise<{
    consentId: string; consumedAt: string; authorization: HealthReservationAuthorization
  }>
}
export interface HealthExecutorAnalyzerResult {
  result: HealthAnalysisResult
  /** Genuine provider receipt when the provider supplies one. */
  providerReceiptId?: string
}
export interface HealthExecutorAnalyzer {
  analyze(request: HealthAnalysisArtifactIdentity & { processorId?: string; requestedAt: string; signal: AbortSignal;
    authorization?: HealthReservationAuthorization }): Promise<HealthExecutorAnalyzerResult>
}
export interface PersistedHealthAnalysisResult {
  executionToken: string
  materialDigest: string
  artifactId: string
  manifestDigest: string
  processorId: string | null
  reservationId: string | null
  requestedAt: string
  analysisId: string
  status: 'succeeded' | 'needs_review' | 'failed'
  observationIds: string[]
  processorReceiptId: string | null
  verificationStatus: 'verified' | 'unverifiable'
}
export interface HealthAnalysisResultWriteRequest extends HealthAnalysisArtifactIdentity {
  executionToken: string
  materialDigest: string
  processorId: string | null
  reservationId: string | null
  requestedAt: string
  result: HealthAnalysisResult
  processorReceiptId: string | null
}
export interface HealthAnalysisResultWriter {
  /** Durable lookup by execution token. The returned material digest is checked by the adapter. */
  lookup(executionToken: string, materialDigest: string): Promise<PersistedHealthAnalysisResult | null>
  /** Atomically persist or replay the exact token + material result. */
  write(request: HealthAnalysisResultWriteRequest): Promise<PersistedHealthAnalysisResult>
}

export function createHealthConsentReservationConsumer(broker: HealthConsentBroker): HealthAnalysisConsentConsumer {
  return { consume: async request => {
    const consumed = await consumeHealthReservation(broker, request.consentId, {
      artifactId: request.artifactId, artifactManifestDigest: request.manifestDigest, processorId: request.processorId,
    })
    return { consentId: consumed.reservationId, consumedAt: consumed.consumedAt, authorization: consumed.authorization }
  } }
}

export function createAuthorizedAuxiliaryVisionExecutorAnalyzer(
  analyzer: AuxiliaryVisionAnalyzer,
  profile = 'default',
): HealthExecutorAnalyzer {
  return { async analyze(request) {
    const reserved = readHealthReservationAuthorization((request as { authorization?: unknown }).authorization)
    const authorized = (analyzer as unknown as Record<PropertyKey, unknown>)[AUTHORIZED_AUXILIARY_ANALYZE]
    if (!reserved || typeof authorized !== 'function' || reserved.artifactId !== request.artifactId
      || reserved.artifactManifestDigest !== request.manifestDigest || reserved.processorId !== request.processorId
      || reserved.manifest.artifactIds.length !== 1 || reserved.manifest.artifactIds[0] !== reserved.artifactId) {
      throw new Error('HEALTH_ANALYSIS_CONSENT_DENIED')
    }
    const result = await (authorized as (input: object, authorization: HealthReservationAuthorization) => Promise<HealthAnalysisResult>)(
      { schemaVersion: 'health-analysis-request/v1', profile, purpose: reserved.manifest.purpose,
        sourceId: `fabric.${reserved.processorId}`, observedAt: request.requestedAt,
        artifactIds: [reserved.artifactId], selectedRegions: [...reserved.manifest.selectedRegions],
        requestedFields: [...reserved.manifest.requestedFields] },
      (request as { authorization: HealthReservationAuthorization }).authorization,
    )
    return { result }
  } }
}

export interface HealthAnalysisExecutorOptions {
  locality: 'local' | 'remote'
  analyzer?: HealthExecutorAnalyzer
  artifactResolver?: HealthAnalysisArtifactResolver
  consentConsumer?: HealthAnalysisConsentConsumer
  resultWriter?: HealthAnalysisResultWriter
}

export function createHealthAnalysisExecutorAdapter(options: HealthAnalysisExecutorOptions): FabricExecutorAdapter {
  const executions = new Map<string, { materialDigest: string; promise: Promise<FabricExecuteResult> }>()
  const id = options.locality === 'local' ? 'health-local-analysis' : 'health-remote-analysis'
  return {
    id, type: options.locality === 'local' ? 'internal' : 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      if (!options.analyzer || !options.artifactResolver || !options.resultWriter) {
        return failure('failed', 'HEALTH_ANALYSIS_DEPENDENCY_UNAVAILABLE')
      }
      if (!matchesCapability(options.locality, context.capabilityId)) return failure('failed', 'HEALTH_ANALYSIS_CAPABILITY_UNSUPPORTED')
      try {
        const identity = inputIdentity(context.input)
        const resolved = await options.artifactResolver.resolve(identity.artifactId)
        if (!resolved || resolved.artifactId !== identity.artifactId || resolved.manifestDigest !== identity.manifestDigest) {
          return failure('failed', 'HEALTH_ANALYSIS_ARTIFACT_MISMATCH')
        }
        return success('prepared', context, { artifactId: identity.artifactId, manifestDigest: identity.manifestDigest })
      } catch { return failure('failed', 'HEALTH_ANALYSIS_PREPARE_FAILED') }
    },
    execute(context): Promise<FabricExecuteResult> {
      const materialDigest = executionMaterial(context)
      const existing = executions.get(context.executionToken)
      if (existing) return existing.materialDigest === materialDigest ? existing.promise
        : Promise.resolve(failure('permanent_failure', 'HEALTH_ANALYSIS_EXECUTION_TOKEN_CONFLICT'))
      const promise = executeOnce(options, context, materialDigest)
      executions.set(context.executionToken, { materialDigest, promise })
      promise.then(() => {
        if (executions.get(context.executionToken)?.promise === promise) executions.delete(context.executionToken)
      }, () => {
        if (executions.get(context.executionToken)?.promise === promise) executions.delete(context.executionToken)
      })
      return promise
    },
    async verify(context): Promise<FabricVerifyResult> {
      let identity: HealthAnalysisArtifactIdentity
      try { identity = inputIdentity(context.input) } catch { return failure('mismatch', 'HEALTH_ANALYSIS_VERIFICATION_MISMATCH') }
      const digest = executionMaterial(context)
      const stored = await lookupPersisted(options, context.executionToken, digest)
      if (!stored || stored === 'unavailable' || !validPersistedResult(stored, options.locality, context, identity, digest)
        || !analysisOutputMatches(context.executionOutput, stored, options.locality, context)) {
        return failure('unknown', 'HEALTH_ANALYSIS_VERIFICATION_UNAVAILABLE')
      }
      if (stored.verificationStatus !== 'verified') return failure('unknown', 'HEALTH_ANALYSIS_PROVIDER_UNVERIFIABLE')
      return success('verified', context, { analysisId: stored.analysisId, processorReceiptId: stored.processorReceiptId })
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'HEALTH_ANALYSIS_INTERRUPT_UNSUPPORTED')
    },
    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'HEALTH_ANALYSIS_COMPENSATION_UNSUPPORTED')
    },
  }
}

async function executeOnce(options: HealthAnalysisExecutorOptions, context: FabricExecutionContext,
  materialDigest: string): Promise<FabricExecuteResult> {
  if (!options.analyzer || !options.resultWriter) return failure('permanent_failure', 'HEALTH_ANALYSIS_DEPENDENCY_UNAVAILABLE')
  let identity: HealthAnalysisArtifactIdentity
  try {
    identity = inputIdentity(context.input)
    if (!context.preparedOutput || context.preparedOutput.artifactId !== identity.artifactId
      || context.preparedOutput.manifestDigest !== identity.manifestDigest) throw new Error('invalid')
  } catch { return failure('permanent_failure', 'HEALTH_ANALYSIS_PREPARATION_INVALID') }

  const prior = await lookupPersisted(options, context.executionToken, materialDigest)
  if (prior === 'unavailable') return failure('unknown', 'HEALTH_ANALYSIS_RESULT_STORE_UNAVAILABLE')
  if (prior) return prior.materialDigest === materialDigest
    ? persistedOutput(options.locality, context, identity, prior, materialDigest)
    : failure('permanent_failure', 'HEALTH_ANALYSIS_EXECUTION_TOKEN_CONFLICT')

  let consentId: string | undefined
  let authorization: HealthReservationAuthorization | undefined
  if (options.locality === 'remote') {
    const processorId = context.input.processorId
    const suppliedConsentId = context.input.consentId
    if (!options.consentConsumer || typeof processorId !== 'string' || typeof suppliedConsentId !== 'string') {
      return failure('permanent_failure', 'HEALTH_ANALYSIS_CONSENT_UNAVAILABLE')
    }
    try {
      const consumed = await options.consentConsumer.consume({ ...identity, processorId, consentId: suppliedConsentId })
      if (consumed.consentId !== suppliedConsentId) return failure('permanent_failure', 'HEALTH_ANALYSIS_CONSENT_MISMATCH')
      consentId = consumed.consentId
      authorization = consumed.authorization
    } catch { return failure('permanent_failure', 'HEALTH_ANALYSIS_CONSENT_DENIED') }
  }

  let analyzed: HealthExecutorAnalyzerResult
  try {
    analyzed = await options.analyzer.analyze({ ...identity,
      ...(options.locality === 'remote' ? { processorId: context.input.processorId as string } : {}),
      requestedAt: String(context.input.requestedAt), signal: new AbortController().signal,
      ...(authorization ? { authorization } : {}) })
  } catch {
    return failure('unknown', options.locality === 'remote'
      ? 'HEALTH_ANALYSIS_REMOTE_RESULT_UNCERTAIN' : 'HEALTH_ANALYSIS_LOCAL_FAILED')
  }

  let result: HealthAnalysisResult
  let processorReceiptId: string | null = null
  try {
    result = canonicalAnalysisResult(analyzed?.result, {
      locality: options.locality, artifactId: identity.artifactId, requestedAt: String(context.input.requestedAt),
    })
    if (options.locality === 'remote') {
      if (analyzed.providerReceiptId !== undefined && !semanticId(analyzed.providerReceiptId)) throw new Error('invalid')
      processorReceiptId = analyzed.providerReceiptId ?? null
    }
  } catch { return failure('permanent_failure', 'HEALTH_ANALYSIS_RESULT_INVALID') }

  try {
    const stored = await options.resultWriter.write({ ...identity, executionToken: context.executionToken, materialDigest,
      processorId: options.locality === 'remote' ? String(context.input.processorId) : null,
      reservationId: consentId ?? null, requestedAt: String(context.input.requestedAt), result, processorReceiptId })
    return stored.materialDigest === materialDigest
      ? persistedOutput(options.locality, context, identity, stored, materialDigest)
      : failure('permanent_failure', 'HEALTH_ANALYSIS_EXECUTION_TOKEN_CONFLICT')
  } catch {
    const recovered = await lookupPersisted(options, context.executionToken, materialDigest)
    if (recovered && recovered !== 'unavailable') return recovered.materialDigest === materialDigest
      ? persistedOutput(options.locality, context, identity, recovered, materialDigest)
      : failure('permanent_failure', 'HEALTH_ANALYSIS_EXECUTION_TOKEN_CONFLICT')
    return failure('unknown', 'HEALTH_ANALYSIS_RESULT_STORE_UNAVAILABLE')
  }
}

async function lookupPersisted(options: HealthAnalysisExecutorOptions, executionToken: string, materialDigest: string):
Promise<PersistedHealthAnalysisResult | 'unavailable' | null> {
  try { return await options.resultWriter!.lookup(executionToken, materialDigest) }
  catch { return 'unavailable' }
}

function persistedOutput(locality: 'local' | 'remote', context: FabricExecutionContext,
  identity: HealthAnalysisArtifactIdentity, result: PersistedHealthAnalysisResult, materialDigest: string): FabricExecuteResult {
  if (!validPersistedResult(result, locality, context, identity, materialDigest)) {
    return failure('permanent_failure', 'HEALTH_ANALYSIS_RESULT_INVALID')
  }
  const ids = result.observationIds.slice(0, 64)
  const output = { schemaVersion: 1, artifactId: identity.artifactId,
    analysisId: result.analysisId, status: result.status, observationIds: ids,
    totalCount: result.observationIds.length, omittedCount: result.observationIds.length - ids.length,
    continuationCursor: result.observationIds.length > ids.length ? `analysis:${result.analysisId}:64` : null,
    ...(locality === 'remote' ? { processorReceiptId: result.processorReceiptId,
      verificationStatus: result.verificationStatus, consentId: context.input.consentId } : {}) } as FabricJsonObject
  return locality === 'remote' && result.verificationStatus === 'unverifiable'
    ? { outcome: 'unknown', output, evidence: [], errorCode: 'HEALTH_ANALYSIS_PROVIDER_UNVERIFIABLE', safeToRetry: false }
    : success('succeeded', context, output)
}

function canonicalAnalysisResult(value: unknown, binding: {
  locality: 'local' | 'remote'; artifactId: string; requestedAt: string
}): HealthAnalysisResult {
  const result = validateHealthAnalysisResult(value, binding)
  if (Buffer.byteLength(stableStringify(result), 'utf8') > MAX_RESULT_BYTES) throw new Error('invalid')
  return result
}

function executionMaterial(context: FabricExecutionContext): string {
  return createHash('sha256').update(stableStringify({ capabilityId: context.capabilityId,
    input: context.input, target: context.target })).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('invalid')
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid')
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  if (entries.some(([, item]) => item === undefined)) throw new Error('invalid')
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

function inputIdentity(input: FabricJsonObject): HealthAnalysisArtifactIdentity {
  if (typeof input.artifactId !== 'string' || input.artifactId.length < 1 || input.artifactId.length > 200
    || typeof input.manifestDigest !== 'string' || !DIGEST.test(input.manifestDigest)) throw new Error('invalid')
  return { artifactId: input.artifactId, manifestDigest: input.manifestDigest }
}
function matchesCapability(locality: 'local' | 'remote', id: string): boolean {
  return id === `health.artifact.analyze.${locality}`
}
function validPersistedResult(value: PersistedHealthAnalysisResult, locality: 'local' | 'remote', context: FabricExecutionContext,
  identity: HealthAnalysisArtifactIdentity, materialDigest: string): boolean {
  return !!value && value.executionToken === context.executionToken && value.materialDigest === materialDigest
    && value.artifactId === identity.artifactId && value.manifestDigest === identity.manifestDigest
    && value.requestedAt === context.input.requestedAt && semanticId(value.analysisId)
    && ['succeeded', 'needs_review', 'failed'].includes(value.status) && Array.isArray(value.observationIds)
    && value.observationIds.length <= 4096 && value.observationIds.every(semanticId)
    && ['verified', 'unverifiable'].includes(value.verificationStatus)
    && (locality === 'local'
      ? value.processorId === null && value.reservationId === null && value.processorReceiptId === null
      : value.processorId === context.input.processorId && value.reservationId === context.input.consentId
        && ((value.verificationStatus === 'verified' && semanticId(value.processorReceiptId))
          || (value.verificationStatus === 'unverifiable' && value.processorReceiptId === null && value.status === 'needs_review')))
}

function analysisOutputMatches(output: FabricJsonObject | undefined, result: PersistedHealthAnalysisResult,
  locality: 'local' | 'remote', context: FabricExecutionContext): boolean {
  if (!output) return false
  const ids = result.observationIds.slice(0, 64)
  return output.artifactId === result.artifactId && output.analysisId === result.analysisId && output.status === result.status
    && stableStringify(output.observationIds) === stableStringify(ids)
    && output.totalCount === result.observationIds.length && output.omittedCount === result.observationIds.length - ids.length
    && output.continuationCursor === (result.observationIds.length > ids.length ? `analysis:${result.analysisId}:64` : null)
    && (locality === 'local' || (output.consentId === context.input.consentId
      && output.processorReceiptId === result.processorReceiptId && output.verificationStatus === result.verificationStatus))
}
function semanticId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !isFabricSensitiveString(value)
}
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: [{ kind: 'health_analysis', summary: outcome,
    data: { artifactId: context.input.artifactId, locality: context.capabilityId.endsWith('.remote') ? 'remote' : 'local' },
    capturedAt: context.now ?? new Date().toISOString() }], errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
