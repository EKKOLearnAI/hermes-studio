import { createHash } from 'crypto'
import type { FabricExecutionContext, FabricExecutorAdapter, FabricExecuteResult } from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'

export interface HealthSourceSyncResult {
  executionToken: string
  materialDigest: string
  connectorId: string
  requestedAt: string
  cursor: string | null
  syncId: string
  status: 'succeeded' | 'partial' | 'failed'
  recordIds: string[]
}
export interface HealthSourceService {
  lookup(executionToken: string, materialDigest: string): Promise<HealthSourceSyncResult | null>
  write(request: { connectorId: string; requestedAt: string; cursor: string | null;
    executionToken: string; materialDigest: string }): Promise<HealthSourceSyncResult>
}

export function createHealthSourceExecutorAdapter(service?: HealthSourceService): FabricExecutorAdapter {
  return {
    id: 'health-source', type: 'connector',
    async prepare(context) {
      if (!service) return failure('failed', 'HEALTH_SOURCE_DEPENDENCY_UNAVAILABLE')
      return success('prepared', context, { materialDigest: material(context) })
    },
    async execute(context): Promise<FabricExecuteResult> {
      if (!service || context.preparedOutput?.materialDigest !== material(context)) {
        return failure('permanent_failure', 'HEALTH_SOURCE_PREPARATION_INVALID')
      }
      try {
        const digest = material(context)
        const prior = await service.lookup(context.executionToken, digest)
        const result = prior ?? await service.write({ connectorId: String(context.input.connectorId),
          requestedAt: String(context.input.requestedAt), cursor: typeof context.input.cursor === 'string' ? context.input.cursor : null,
          executionToken: context.executionToken, materialDigest: digest })
        if (!validResult(result, context, digest)) return failure('permanent_failure', 'HEALTH_SOURCE_RESULT_INVALID')
        return sourceResult(context, result)
      } catch { return failure('unknown', 'HEALTH_SOURCE_RESULT_UNCERTAIN') }
    },
    async verify(context) {
      if (!service) return failure('unknown', 'HEALTH_SOURCE_DEPENDENCY_UNAVAILABLE')
      try {
        const result = await service.lookup(context.executionToken, material(context))
        return result && validResult(result, context, material(context)) && outputMatches(context.executionOutput, result)
          ? result.status === 'failed' ? failure('mismatch', 'HEALTH_SOURCE_SYNC_FAILED')
            : success('verified', context, { syncId: result.syncId })
          : failure('unknown', 'HEALTH_SOURCE_VERIFICATION_UNAVAILABLE')
      } catch { return failure('unknown', 'HEALTH_SOURCE_VERIFICATION_UNAVAILABLE') }
    },
    async interrupt() { return failure('unsupported', 'HEALTH_SOURCE_INTERRUPT_UNSUPPORTED') },
    async compensate() { return failure('unsupported', 'HEALTH_SOURCE_COMPENSATION_UNSUPPORTED') },
  }
}

function material(context: FabricExecutionContext): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId: context.capabilityId,
    input: context.input, target: context.target })).digest('hex')
}
function validResult(value: HealthSourceSyncResult, context: FabricExecutionContext, digest: string): boolean {
  const semantic = (item: unknown) => typeof item === 'string' && item.length >= 1 && item.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(item)
  return !!value && value.executionToken === context.executionToken && value.materialDigest === digest
    && value.connectorId === context.input.connectorId && value.requestedAt === context.input.requestedAt
    && value.cursor === (typeof context.input.cursor === 'string' ? context.input.cursor : null) && semantic(value.syncId)
    && ['succeeded', 'partial', 'failed'].includes(value.status) && Array.isArray(value.recordIds)
    && value.recordIds.length <= 4096 && value.recordIds.every(semantic)
}
function sourceResult(context: FabricExecutionContext, result: HealthSourceSyncResult): FabricExecuteResult {
  const ids = result.recordIds.slice(0, 64)
  const output = { schemaVersion: 1, connectorId: result.connectorId, syncId: result.syncId,
    status: result.status, recordIds: ids, totalCount: result.recordIds.length,
    omittedCount: result.recordIds.length - ids.length,
    continuationCursor: result.recordIds.length > ids.length ? `sync:${result.syncId}:64` : null }
  return result.status === 'failed'
    ? { outcome: 'permanent_failure', output, evidence: [], errorCode: 'HEALTH_SOURCE_SYNC_FAILED', safeToRetry: false }
    : success('succeeded', context, output)
}
function outputMatches(output: FabricJsonObject | undefined, result: HealthSourceSyncResult): boolean {
  if (!output) return false
  const ids = result.recordIds.slice(0, 64)
  return output.connectorId === result.connectorId && output.syncId === result.syncId && output.status === result.status
    && JSON.stringify(output.recordIds) === JSON.stringify(ids) && output.totalCount === result.recordIds.length
    && output.omittedCount === result.recordIds.length - ids.length
    && output.continuationCursor === (result.recordIds.length > ids.length ? `sync:${result.syncId}:64` : null)
}
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: [{ kind: 'health_source', summary: outcome, data: { connectorId: context.input.connectorId },
    capturedAt: context.now ?? new Date().toISOString() }], errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
