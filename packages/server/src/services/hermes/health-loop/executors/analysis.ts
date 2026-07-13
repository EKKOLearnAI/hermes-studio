import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'
import { isFabricSensitiveString } from '../../action-fabric/audit'

const DIGEST = /^[a-f0-9]{64}$/

export interface HealthAnalysisArtifactIdentity { artifactId: string; manifestDigest: string }
export interface HealthAnalysisArtifactResolver {
  resolve(artifactId: string): Promise<HealthAnalysisArtifactIdentity | null>
}
export interface HealthAnalysisConsentRequest extends HealthAnalysisArtifactIdentity { consentId: string; processorId: string }
export interface HealthAnalysisConsentConsumer {
  consume(request: HealthAnalysisConsentRequest): Promise<{ consentId: string; consumedAt: string }>
}
export interface HealthExecutorAnalysisResult {
  analysisId: string
  status: 'succeeded' | 'needs_review' | 'failed'
  observationIds: string[]
  processorReceiptId?: string
}
export interface HealthExecutorAnalyzer {
  analyze(request: HealthAnalysisArtifactIdentity & { processorId?: string; requestedAt: string; signal: AbortSignal }):
    Promise<HealthExecutorAnalysisResult>
}
export interface HealthAnalysisExecutorOptions {
  locality: 'local' | 'remote'
  analyzer?: HealthExecutorAnalyzer
  artifactResolver?: HealthAnalysisArtifactResolver
  consentConsumer?: HealthAnalysisConsentConsumer
}

export function createHealthAnalysisExecutorAdapter(options: HealthAnalysisExecutorOptions): FabricExecutorAdapter {
  const executions = new Map<string, Promise<FabricExecuteResult>>()
  const controllers = new Map<string, AbortController>()
  const id = options.locality === 'local' ? 'health-local-analysis' : 'health-remote-analysis'
  return {
    id, type: options.locality === 'local' ? 'internal' : 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      if (!options.analyzer || !options.artifactResolver) return failure('failed', 'HEALTH_ANALYSIS_DEPENDENCY_UNAVAILABLE')
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
      const existing = executions.get(context.executionToken)
      if (existing) return existing
      const pending = executeOnce(options, context, controllers)
      executions.set(context.executionToken, pending)
      return pending
    },
    async verify(context): Promise<FabricVerifyResult> {
      const output = context.executionOutput
      if (!output || output.artifactId !== context.input.artifactId || typeof output.analysisId !== 'string') {
        return failure('mismatch', 'HEALTH_ANALYSIS_VERIFICATION_MISMATCH')
      }
      if (options.locality === 'remote' && (output.consentId !== context.input.consentId
        || typeof output.processorReceiptId !== 'string')) {
        return failure('mismatch', 'HEALTH_ANALYSIS_VERIFICATION_MISMATCH')
      }
      return success('verified', context, { analysisId: output.analysisId,
        ...(output.processorReceiptId ? { processorReceiptId: output.processorReceiptId } : {}) })
    },
    async interrupt(context): Promise<FabricInterruptResult> {
      const controller = controllers.get(context.executionToken)
      if (!controller) return failure('unsupported', 'HEALTH_ANALYSIS_INTERRUPT_NOT_RUNNING')
      controller.abort()
      return success('interrupted', context, {})
    },
    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'HEALTH_ANALYSIS_COMPENSATION_UNSUPPORTED')
    },
  }
}

async function executeOnce(options: HealthAnalysisExecutorOptions, context: FabricExecutionContext,
  controllers: Map<string, AbortController>): Promise<FabricExecuteResult> {
  if (!options.analyzer) return failure('permanent_failure', 'HEALTH_ANALYSIS_DEPENDENCY_UNAVAILABLE')
  let identity: HealthAnalysisArtifactIdentity
  try {
    identity = inputIdentity(context.input)
    if (!context.preparedOutput || context.preparedOutput.artifactId !== identity.artifactId
      || context.preparedOutput.manifestDigest !== identity.manifestDigest) throw new Error('invalid')
  } catch { return failure('permanent_failure', 'HEALTH_ANALYSIS_PREPARATION_INVALID') }
  let consentId: string | undefined
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
    } catch { return failure('permanent_failure', 'HEALTH_ANALYSIS_CONSENT_DENIED') }
  }
  const controller = new AbortController()
  controllers.set(context.executionToken, controller)
  try {
    const result = await options.analyzer.analyze({ ...identity,
      ...(options.locality === 'remote' ? { processorId: context.input.processorId as string } : {}),
      requestedAt: String(context.input.requestedAt), signal: controller.signal })
    if (!validResult(result, options.locality)) return failure('permanent_failure', 'HEALTH_ANALYSIS_RESULT_INVALID')
    const ids = result.observationIds.slice(0, 64)
    return success('succeeded', context, { schemaVersion: 1, artifactId: identity.artifactId,
      analysisId: result.analysisId, status: result.status, observationIds: ids,
      totalCount: result.observationIds.length, omittedCount: result.observationIds.length - ids.length,
      continuationCursor: result.observationIds.length > ids.length ? `analysis:${result.analysisId}:64` : null,
      ...(options.locality === 'remote' ? { processorReceiptId: result.processorReceiptId, consentId } : {}) })
  } catch {
    // Consent may already be consumed and the remote processor may already have acted. Never mark this retry-safe.
    return failure('unknown', options.locality === 'remote'
      ? 'HEALTH_ANALYSIS_REMOTE_RESULT_UNCERTAIN' : 'HEALTH_ANALYSIS_LOCAL_FAILED')
  } finally { controllers.delete(context.executionToken) }
}

function inputIdentity(input: FabricJsonObject): HealthAnalysisArtifactIdentity {
  if (typeof input.artifactId !== 'string' || input.artifactId.length < 1 || input.artifactId.length > 200
    || typeof input.manifestDigest !== 'string' || !DIGEST.test(input.manifestDigest)) throw new Error('invalid')
  return { artifactId: input.artifactId, manifestDigest: input.manifestDigest }
}
function matchesCapability(locality: 'local' | 'remote', id: string): boolean {
  return id === `health.artifact.analyze.${locality}`
}
function validResult(value: HealthExecutorAnalysisResult, locality: 'local' | 'remote'): boolean {
  return !!value && typeof value.analysisId === 'string' && value.analysisId.length > 0 && value.analysisId.length <= 200
    && !isFabricSensitiveString(value.analysisId)
    && ['succeeded', 'needs_review', 'failed'].includes(value.status) && Array.isArray(value.observationIds)
    && value.observationIds.length <= 4096
    && value.observationIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !isFabricSensitiveString(id))
    && (locality === 'local' || (typeof value.processorReceiptId === 'string' && value.processorReceiptId.length > 0
      && value.processorReceiptId.length <= 256 && !isFabricSensitiveString(value.processorReceiptId)))
}
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: [{ kind: 'health_analysis', summary: outcome,
    data: { artifactId: context.input.artifactId, locality: context.capabilityId.endsWith('.remote') ? 'remote' : 'local' },
    capturedAt: context.now ?? new Date().toISOString() }], errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
