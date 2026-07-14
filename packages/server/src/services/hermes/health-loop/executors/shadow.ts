import { createHash } from 'crypto'
import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'

export function createHealthShadowExecutorAdapter(): FabricExecutorAdapter {
  return {
    id: 'health-shadow', type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      return success('prepared', context, { shadow: true, materialDigest: materialDigest(context) })
    },
    async execute(context): Promise<FabricExecuteResult> {
      if (context.preparedOutput?.shadow !== true
        || context.preparedOutput.materialDigest !== materialDigest(context)) {
        return failure('permanent_failure', 'HEALTH_SHADOW_PREPARATION_INVALID')
      }
      const output = shadowOutput(context)
      return output ? success('succeeded', context, output) : failure('permanent_failure', 'HEALTH_SHADOW_CAPABILITY_UNSUPPORTED')
    },
    async verify(context): Promise<FabricVerifyResult> {
      const expected = shadowOutput(context)
      return expected && canonical(expected) === canonical(context.executionOutput)
        ? success('verified', context, { shadow: true })
        : failure('mismatch', 'HEALTH_SHADOW_VERIFICATION_MISMATCH')
    },
    async interrupt(context): Promise<FabricInterruptResult> {
      return success('interrupted', context, { shadow: true })
    },
    async compensate(context): Promise<FabricCompensateResult> {
      return success('compensated', context, { shadow: true, sideEffectsReversed: 0 })
    },
  }
}

function shadowOutput(context: FabricExecutionContext): FabricJsonObject | null {
  const id = createHash('sha256').update(context.executionToken).digest('hex').slice(0, 24)
  const input = context.input
  switch (context.capabilityId) {
    case 'health.source.sync': return { schemaVersion: 1, connectorId: input.connectorId,
      syncId: `shadow-${id}`, status: 'succeeded', recordIds: [], totalCount: 0, omittedCount: 0, continuationCursor: null }
    case 'health.artifact.analyze.local': return analysisOutput(input, id, false)
    case 'health.artifact.analyze.remote': return analysisOutput(input, id, true)
    case 'health.plan.adjust': {
      const previousVersion = Number(input.expectedVersion)
      return { schemaVersion: 1, planId: input.planId, previousVersion, newVersion: previousVersion + 1,
        previousDigest: createHash('sha256').update(`shadow-prior:${String(input.planId)}:${previousVersion}`).digest('hex'),
        planDigest: createHash('sha256').update(`shadow-next:${String(input.planId)}:${previousVersion + 1}`).digest('hex') }
    }
    case 'health.plan.restore': return { schemaVersion: 1, planId: input.planId,
      restoredVersion: input.restoreVersion, planDigest: input.restoreDigest, status: 'restored' }
    case 'health.reminder.send':
    case 'health.checkin.request': return { schemaVersion: 1, deliveryId: `shadow-${id}`, providerMessageId: null, status: 'shadowed' }
    case 'health.followup.schedule': return { schemaVersion: 1, followupId: input.followupId,
      scheduledAt: input.dueAt, status: 'scheduled' }
    default: return null
  }
}

function analysisOutput(input: FabricJsonObject, id: string, remote: boolean): FabricJsonObject {
  return { schemaVersion: 1, artifactId: input.artifactId, analysisId: `shadow-${id}`, status: 'needs_review',
    observationIds: [], totalCount: 0, omittedCount: 0, continuationCursor: null,
    ...(remote ? { processorReceiptId: null, verificationStatus: 'unverifiable', consentId: input.consentId } : {}) }
}

function materialDigest(context: FabricExecutionContext): string {
  return createHash('sha256').update(canonical({ capabilityId: context.capabilityId, input: context.input,
    target: context.target, executionToken: context.executionToken })).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: [{ kind: 'health_shadow', summary: 'No live side effect was performed',
    data: { capabilityId: context.capabilityId, shadow: true }, capturedAt: context.now ?? new Date().toISOString() }],
  errorCode: null, safeToRetry: false }
}

function failure<T extends string>(outcome: T, errorCode: string) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false }
}
