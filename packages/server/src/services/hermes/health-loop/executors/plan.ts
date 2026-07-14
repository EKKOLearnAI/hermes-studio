import { createHash } from 'crypto'
import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'

const DIGEST = /^[a-f0-9]{64}$/

export interface HealthPlanSnapshot { planId: string; version: number; digest: string }
export interface HealthPlanRepository {
  read(planId: string): Promise<HealthPlanSnapshot | null>
  /** Must atomically apply CAS and persist/replay the result under executionToken + materialDigest. */
  adjust(request: { planId: string; expectedVersion: number; expectedDigest: string; operation: FabricJsonObject;
    executionToken: string; materialDigest: string }):
    Promise<{ previous: HealthPlanSnapshot; current: HealthPlanSnapshot } | null>
  restore(request: { planId: string; expectedCurrentVersion: number; expectedCurrentDigest: string;
    restoreVersion: number; restoreDigest: string; executionToken: string; materialDigest: string }): Promise<HealthPlanSnapshot | null>
  scheduleFollowup?(request: { followupId: string; ownerUserId: string; category: string; operation: string;
    reasonCode: string; dueAt: string; executionToken: string; materialDigest: string }): Promise<HealthFollowupRecord | null>
  readFollowup?(followupId: string): Promise<HealthFollowupRecord | null>
}
export interface HealthFollowupRecord { followupId: string; scheduledAt: string; status: 'scheduled' | 'superseded' }

export interface HealthPlanExecutorOptions { repository?: HealthPlanRepository }

export function createHealthPlanExecutorAdapter(options: HealthPlanExecutorOptions = {}): FabricExecutorAdapter {
  const repository = options.repository
  return {
    id: 'health-plan', type: 'internal',
    async prepare(context): Promise<FabricPrepareResult> {
      if (!repository) return failure('failed', 'HEALTH_PLAN_REPOSITORY_UNAVAILABLE')
      try {
        if (context.capabilityId === 'health.followup.schedule') {
          if (!repository.scheduleFollowup || !repository.readFollowup) return failure('failed', 'HEALTH_FOLLOWUP_REPOSITORY_UNAVAILABLE')
          return success('prepared', context, { followupId: context.input.followupId, materialDigest: executionMaterial(context) })
        }
        const planId = planIdOf(context.input)
        const current = await repository.read(planId)
        if (!validSnapshot(current, planId)) return failure('failed', 'HEALTH_PLAN_NOT_FOUND')
        const expected = context.capabilityId === 'health.plan.adjust'
          ? context.input.expectedVersion : context.input.expectedCurrentVersion
        if (current.version !== expected) return failure('failed', 'HEALTH_PLAN_CAS_CONFLICT')
        return success('prepared', context, { planId, version: current.version, digest: current.digest })
      } catch { return failure('failed', 'HEALTH_PLAN_PREPARE_FAILED') }
    },
    execute(context): Promise<FabricExecuteResult> {
      return executePlan(repository, context)
    },
    async verify(context): Promise<FabricVerifyResult> {
      if (!repository) return failure('unknown', 'HEALTH_PLAN_REPOSITORY_UNAVAILABLE')
      try {
        if (context.capabilityId === 'health.followup.schedule') {
          if (!repository.readFollowup || typeof context.input.followupId !== 'string') {
            return failure('unknown', 'HEALTH_FOLLOWUP_REPOSITORY_UNAVAILABLE')
          }
          const current = await repository.readFollowup(context.input.followupId)
          return validFollowup(current, context.input.followupId)
            && current.scheduledAt === context.executionOutput?.scheduledAt && current.status === context.executionOutput?.status
            ? success('verified', context, { followupId: current.followupId })
            : failure('mismatch', 'HEALTH_FOLLOWUP_VERIFICATION_MISMATCH')
        }
        const planId = planIdOf(context.input)
        const current = await repository.read(planId)
        const expectedVersion = context.capabilityId === 'health.plan.adjust'
          ? context.executionOutput?.newVersion : context.executionOutput?.restoredVersion
        return validSnapshot(current, planId) && current.version === expectedVersion
          && current.digest === context.executionOutput?.planDigest
          ? success('verified', context, { planId, version: current.version, digest: current.digest })
          : failure('mismatch', 'HEALTH_PLAN_VERIFICATION_MISMATCH')
      } catch { return failure('unknown', 'HEALTH_PLAN_VERIFY_FAILED') }
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'HEALTH_PLAN_INTERRUPT_UNSUPPORTED')
    },
    async compensate(context): Promise<FabricCompensateResult> {
      if (!repository || context.capabilityId !== 'health.plan.adjust') {
        return failure('unsupported', 'HEALTH_PLAN_COMPENSATION_UNSUPPORTED')
      }
      try {
        const prepared = preparedSnapshot(context)
        const executed = adjustmentOutput(context.executionOutput, prepared.planId)
        const restored = await repository.restore({ planId: prepared.planId,
          expectedCurrentVersion: executed.newVersion, expectedCurrentDigest: executed.planDigest,
          restoreVersion: prepared.version, restoreDigest: prepared.digest,
          executionToken: `compensate:${context.executionToken}`, materialDigest: executionMaterial(context) })
        return validSnapshot(restored, prepared.planId) && restored.version === prepared.version && restored.digest === prepared.digest
          ? success('compensated', context, { planId: restored.planId, version: restored.version, digest: restored.digest })
          : failure('failed', 'HEALTH_PLAN_COMPENSATION_CONFLICT')
      } catch { return failure('unknown', 'HEALTH_PLAN_COMPENSATION_FAILED') }
    },
  }
}

async function executePlan(repository: HealthPlanRepository | undefined, context: FabricExecutionContext): Promise<FabricExecuteResult> {
  if (!repository) return failure('permanent_failure', 'HEALTH_PLAN_REPOSITORY_UNAVAILABLE')
  const materialDigest = executionMaterial(context)
  if (context.capabilityId === 'health.followup.schedule') {
    if (!repository.scheduleFollowup || context.preparedOutput?.materialDigest !== materialDigest) {
      return failure('permanent_failure', 'HEALTH_FOLLOWUP_PREPARATION_INVALID')
    }
    try {
      const result = await repository.scheduleFollowup({ followupId: String(context.input.followupId),
        ownerUserId: String(context.input.ownerUserId), category: String(context.input.category),
        operation: String(context.input.operation), reasonCode: String(context.input.reasonCode), dueAt: String(context.input.dueAt),
        executionToken: context.executionToken, materialDigest })
      if (!validFollowup(result, context.input.followupId)) return failure('permanent_failure', 'HEALTH_FOLLOWUP_CONFLICT')
      return success('succeeded', context, { schemaVersion: 1, followupId: result.followupId,
        scheduledAt: result.scheduledAt, status: result.status })
    } catch { return failure('unknown', 'HEALTH_FOLLOWUP_RESULT_UNCERTAIN') }
  }
  let prepared: HealthPlanSnapshot
  try { prepared = preparedSnapshot(context) } catch { return failure('permanent_failure', 'HEALTH_PLAN_PREPARATION_INVALID') }
  try {
    if (context.capabilityId === 'health.plan.adjust') {
      if (context.input.expectedVersion !== prepared.version) return failure('permanent_failure', 'HEALTH_PLAN_PREPARATION_INVALID')
      const changed = await repository.adjust({ planId: prepared.planId, expectedVersion: prepared.version,
        expectedDigest: prepared.digest, operation: context.input,
        executionToken: context.executionToken, materialDigest })
      if (!changed || !validSnapshot(changed.previous, prepared.planId) || !validSnapshot(changed.current, prepared.planId)
        || changed.previous.version !== prepared.version || changed.previous.digest !== prepared.digest
        || changed.current.version !== prepared.version + 1) return failure('permanent_failure', 'HEALTH_PLAN_CAS_CONFLICT')
      return success('succeeded', context, { schemaVersion: 1, planId: prepared.planId,
        previousVersion: changed.previous.version, newVersion: changed.current.version,
        previousDigest: changed.previous.digest, planDigest: changed.current.digest })
    }
    if (context.capabilityId === 'health.plan.restore') {
      if (context.input.expectedCurrentVersion !== prepared.version
        || typeof context.input.restoreVersion !== 'number' || typeof context.input.restoreDigest !== 'string') {
        return failure('permanent_failure', 'HEALTH_PLAN_PREPARATION_INVALID')
      }
      const restored = await repository.restore({ planId: prepared.planId,
        expectedCurrentVersion: prepared.version, expectedCurrentDigest: prepared.digest,
        restoreVersion: context.input.restoreVersion, restoreDigest: context.input.restoreDigest,
        executionToken: context.executionToken, materialDigest })
      if (!validSnapshot(restored, prepared.planId) || restored.version !== context.input.restoreVersion
        || restored.digest !== context.input.restoreDigest) return failure('permanent_failure', 'HEALTH_PLAN_CAS_CONFLICT')
      return success('succeeded', context, { schemaVersion: 1, planId: prepared.planId,
        restoredVersion: restored.version, planDigest: restored.digest, status: 'restored' })
    }
    return failure('permanent_failure', 'HEALTH_PLAN_CAPABILITY_UNSUPPORTED')
  } catch { return failure('unknown', 'HEALTH_PLAN_WRITE_UNCERTAIN') }
}

function executionMaterial(context: FabricExecutionContext): string {
  return createHash('sha256').update(canonical({ capabilityId: context.capabilityId,
    input: context.input, target: context.target })).digest('hex')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function validFollowup(value: HealthFollowupRecord | null, id: unknown): value is HealthFollowupRecord {
  return !!value && value.followupId === id && typeof value.scheduledAt === 'string'
    && new Date(value.scheduledAt).toISOString() === value.scheduledAt && ['scheduled', 'superseded'].includes(value.status)
}

function planIdOf(input: FabricJsonObject): string {
  if (typeof input.planId !== 'string' || input.planId.length < 1 || input.planId.length > 200) throw new Error('invalid')
  return input.planId
}
function validSnapshot(value: HealthPlanSnapshot | null, planId: string): value is HealthPlanSnapshot {
  return !!value && value.planId === planId && Number.isSafeInteger(value.version) && value.version > 0 && DIGEST.test(value.digest)
}
function preparedSnapshot(context: FabricExecutionContext): HealthPlanSnapshot {
  const value = context.preparedOutput
  const planId = planIdOf(context.input)
  if (!value || !validSnapshot(value as unknown as HealthPlanSnapshot, planId)) throw new Error('invalid')
  return value as unknown as HealthPlanSnapshot
}
function adjustmentOutput(value: FabricJsonObject | undefined, planId: string) {
  if (!value || value.planId !== planId || !Number.isSafeInteger(value.newVersion) || !DIGEST.test(String(value.planDigest))) throw new Error('invalid')
  return value as unknown as { newVersion: number; planDigest: string }
}
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: [{ kind: 'health_plan', summary: outcome,
    data: { planId: output.planId ?? context.input.planId }, capturedAt: context.now ?? new Date().toISOString() }],
  errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
