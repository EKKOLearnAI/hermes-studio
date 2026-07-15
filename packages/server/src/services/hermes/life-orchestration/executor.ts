import { createHash } from 'crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  FabricCompensateResult,
  FabricExecutionContext,
  FabricExecuteResult,
  FabricExecutorAdapter,
  FabricInterruptResult,
  FabricPrepareResult,
  FabricVerifyResult,
} from '../action-fabric/executors'
import type { FabricEvidence, FabricJsonObject } from '../action-fabric/types'
import { LifeContractError } from './contracts'
import {
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
  isLifeFabricCapability,
  lifeTargetAtoms,
  validateLifeFabricSemantics,
} from './fabric-contracts'
import { syncLifeSourcePage } from './observation-service'
import {
  LifeProviderError,
  type LifeCalendarAdapter,
  type LifeSourceAdapter,
  type LifeSubscriptionAdapter,
} from './provider'
import { verifyLifePlanRevision } from './planner'
import {
  appendLifeCheckpoint,
  createLifeCalendarHold,
  createLifeSubscriptionCancellation,
  getLifeCalendarHold,
  getLifeCalendarHoldByWorkflow,
  getLifeCommitment,
  getLifeContactAlias,
  getLifeConstraintSnapshot,
  getLifeOption,
  getLifePlanRevision,
  getLifeSourceAccount,
  getLifeSubscription,
  getLifeSubscriptionCancellation,
  getLifeSubscriptionCancellationByWorkflow,
  lifeSubscriptionMaterialDigest,
  transitionLifeCalendarHold,
  transitionLifeSubscriptionCancellation,
} from './store'
import type { LifeSourceAccount } from './types'

const EXECUTOR_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/
const READ_CAPABILITIES = new Set([LIFE_SOURCE_SYNC_CAPABILITY, LIFE_PLAN_VERIFY_CAPABILITY])
const RECOVERABLE_WRITE_CAPABILITIES = new Set([
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
])

export interface LifeExecutorOptions {
  id: string
  providerForAccount: (accountId: string) => LifeSourceAdapter | null
}

interface LifeExecutionBinding {
  account: LifeSourceAccount | null
  provider: LifeSourceAdapter | null
  mode: 'read' | LifeSourceAccount['mode']
  policyEpoch: number
}

export function createLifeExecutorAdapter(options: LifeExecutorOptions): FabricExecutorAdapter {
  if (!EXECUTOR_ID.test(options.id) || typeof options.providerForAccount !== 'function') {
    throw new Error('LIFE_EXECUTOR_CONFIGURATION_INVALID')
  }
  return {
    id: options.id,
    type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        const binding = assertContext(options, context, true)
        assertBoundMaterial(context, binding, true)
        return success('prepared', context, {
          schemaVersion: 1,
          accountId: binding.account?.id ?? null,
          capabilityId: context.capabilityId,
          materialDigest: materialDigest(context),
          mode: binding.mode,
          policyEpoch: binding.policyEpoch,
        })
      } catch (error) {
        return failure('failed', errorCode(error, 'LIFE_PREPARATION_FAILED'))
      }
    },
    async execute(context): Promise<FabricExecuteResult> {
      try {
        const binding = assertContext(options, context, false)
        if (!matchesPrepared(context, binding)) {
          return failure('permanent_failure', 'LIFE_PREPARATION_INVALID')
        }
        assertBoundMaterial(context, binding, false)
        const output = await executeCapability(context, binding)
        return success('succeeded', context, output)
      } catch (error) {
        return executeFailure(error)
      }
    },
    async verify(context): Promise<FabricVerifyResult> {
      try {
        const binding = assertContext(options, context, false)
        const recoveryVerification = RECOVERABLE_WRITE_CAPABILITIES.has(context.capabilityId)
          && (!context.executionOutput || Object.keys(context.executionOutput).length === 0)
        if (!matchesPrepared(context, binding) || (!context.executionOutput && !recoveryVerification)) {
          return failure('failed', 'LIFE_VERIFICATION_PREPARATION_INVALID')
        }
        assertBoundMaterial(context, binding, false)
        if (recoveryVerification) {
          const recovered = await recoverUncertainOutput(context, binding)
          if (!recovered) return failure('unknown', 'LIFE_PROVIDER_RESULT_UNKNOWN')
          return success('verified', context, recovered)
        }
        const current = await currentOutput(context, binding)
        if (!current || !isDeepStrictEqual(current, context.executionOutput)) {
          return failure('mismatch', 'LIFE_VERIFICATION_MISMATCH')
        }
        return success('verified', context, current)
      } catch (error) {
        const code = errorCode(error, 'LIFE_VERIFICATION_FAILED')
        if (error instanceof LifeProviderError && error.uncertain) return failure('unknown', code)
        return failure('failed', code)
      }
    },
    async interrupt(context): Promise<FabricInterruptResult> {
      try {
        const binding = assertContext(options, context, false)
        if (!matchesPrepared(context, binding)) return failure('failed', 'LIFE_PREPARATION_INVALID')
        if (READ_CAPABILITIES.has(context.capabilityId)) {
          return success('interrupted', context, { schemaVersion: 1, sideEffect: false })
        }
        return failure('unsupported', 'LIFE_INTERRUPT_REQUIRES_SEMANTIC_CANCELLATION')
      } catch (error) {
        return failure('failed', errorCode(error, 'LIFE_INTERRUPT_FAILED'))
      }
    },
    async compensate(context): Promise<FabricCompensateResult> {
      try {
        const binding = assertContext(options, context, false)
        if (!matchesPrepared(context, binding)) return failure('failed', 'LIFE_PREPARATION_INVALID')
        if (context.capabilityId !== LIFE_CALENDAR_HOLD_CREATE_CAPABILITY) {
          return failure('unsupported', 'LIFE_COMPENSATION_REQUIRES_SEMANTIC_CAPABILITY')
        }
        const output = await compensateCalendarHold(context, binding)
        return success('compensated', context, output)
      } catch (error) {
        const code = errorCode(error, 'LIFE_COMPENSATION_FAILED')
        if (error instanceof LifeProviderError && error.uncertain) return failure('unknown', code)
        return failure('failed', code)
      }
    },
  }
}

async function executeCapability(
  context: FabricExecutionContext,
  binding: LifeExecutionBinding,
): Promise<FabricJsonObject> {
  switch (context.capabilityId) {
    case LIFE_SOURCE_SYNC_CAPABILITY: {
      const account = requiredAccount(binding)
      const provider = requiredProvider(binding)
      const result = await syncLifeSourcePage({ accountId: account.id, adapter: provider,
        cursor: context.input.cursor as string | null, limit: Number(context.input.limit) })
      const recordIds = result.projections.map(item => item.record.value.id).sort(compare)
      return { schemaVersion: 1, operation: 'source_sync', accountId: account.id,
        sourceKind: account.sourceKind, status: result.nextCursor === null ? 'succeeded' : 'partial',
        recordIds, totalCount: recordIds.length, nextCursor: result.nextCursor }
    }
    case LIFE_PLAN_VERIFY_CAPABILITY:
      return planVerificationOutput(context)
    case LIFE_CALENDAR_HOLD_CREATE_CAPABILITY:
      return executeCalendarCreate(context, requiredAccount(binding), requiredCalendar(binding))
    case LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY:
      return executeCalendarCancel(context, requiredAccount(binding), requiredCalendar(binding))
    case LIFE_SUBSCRIPTION_CANCEL_CAPABILITY:
      return executeSubscriptionCancel(context, requiredAccount(binding), requiredSubscription(binding))
    default:
      throw new LifeContractError('LIFE_CAPABILITY_UNSUPPORTED')
  }
}

async function executeCalendarCreate(
  context: FabricExecutionContext,
  account: LifeSourceAccount,
  provider: LifeCalendarAdapter,
): Promise<FabricJsonObject> {
  let hold = createLifeCalendarHold({ workflowId: context.workflowId, intentId: context.intentId,
    accountId: account.id, planRevisionId: String(context.input.planRevisionId),
    optionId: String(context.input.optionId),
    window: { startsAt: String(context.input.startsAt), endsAt: String(context.input.endsAt) },
    providerRequestId: String(context.input.providerRequestId), createdAt: executionTime(context) })
  if (hold.state === 'confirmed') return calendarOutput(context, hold, 'calendar_hold_create', hold.receiptDigest)
  try {
    if (hold.state === 'lookup_required') {
      const lookup = await provider.lookupCalendarHold({ providerRequestId: hold.providerRequestId })
      if (lookup.status === 'confirmed') {
        hold = confirmHold(hold.id, lookup.providerHoldId!, lookup.receiptDigest!, context)
        return calendarOutput(context, hold, 'calendar_hold_create', lookup.receiptDigest)
      }
      hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
        state: 'submitting', updatedAt: executionTime(context) })
    }
    if (hold.state === 'requested') {
      hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
        state: 'submitting', updatedAt: executionTime(context) })
    }
    if (hold.state !== 'submitting') throw new LifeContractError('LIFE_CALENDAR_HOLD_STATE_INVALID')
    const result = await provider.createCalendarHold({ providerRequestId: hold.providerRequestId,
      planDigest: hold.planDigest, optionId: hold.optionId, window: hold.window })
    const lookup = await provider.lookupCalendarHold({ providerRequestId: hold.providerRequestId })
    if (result.status !== 'confirmed' || lookup.status !== 'confirmed'
      || result.providerHoldId !== lookup.providerHoldId || result.receiptDigest !== lookup.receiptDigest) {
      throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
    }
    hold = confirmHold(hold.id, result.providerHoldId!, result.receiptDigest!, context)
    return calendarOutput(context, hold, 'calendar_hold_create', result.receiptDigest)
  } catch (error) {
    markHoldLookupRequired(hold.id, context)
    throw error
  }
}

async function executeCalendarCancel(
  context: FabricExecutionContext,
  account: LifeSourceAccount,
  provider: LifeCalendarAdapter,
): Promise<FabricJsonObject> {
  let hold = requiredHold(String(context.input.holdId), account.id)
  const request = { providerRequestId: String(context.input.providerRequestId),
    providerHoldId: String(context.input.providerHoldId), reasonCode: String(context.input.reasonCode) }
  try {
    if (hold.state === 'cancelled') {
      const replay = await provider.lookupCalendarCancellation(request)
      if (replay.status !== 'cancelled') throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
      return calendarOutput(context, hold, 'calendar_hold_cancel', replay.receiptDigest)
    }
    if (hold.state === 'confirmed') {
      hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
        state: 'cancel_requested', updatedAt: executionTime(context) })
    }
    if (hold.state === 'cancel_requested') {
      hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
        state: 'cancelling', updatedAt: executionTime(context) })
    }
    if (hold.state === 'lookup_required') {
      const lookup = await provider.lookupCalendarCancellation(request)
      if (lookup.status === 'cancelled') {
        hold = cancelHold(hold.id, context)
        checkpointHold(hold.id, 'provider_cancelled', lookup.receiptDigest!, context)
        return calendarOutput(context, hold, 'calendar_hold_cancel', lookup.receiptDigest)
      }
      hold = transitionLifeCalendarHold({ holdId: hold.id, expectedVersion: hold.version,
        state: 'cancelling', updatedAt: executionTime(context) })
    }
    if (hold.state !== 'cancelling') throw new LifeContractError('LIFE_CALENDAR_HOLD_STATE_INVALID')
    const result = await provider.cancelCalendarHold(request)
    const lookup = await provider.lookupCalendarCancellation(request)
    if (result.status !== 'cancelled' || lookup.status !== 'cancelled'
      || result.providerHoldId !== lookup.providerHoldId || result.receiptDigest !== lookup.receiptDigest) {
      throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
    }
    hold = cancelHold(hold.id, context)
    checkpointHold(hold.id, 'provider_cancelled', result.receiptDigest!, context)
    return calendarOutput(context, hold, 'calendar_hold_cancel', result.receiptDigest)
  } catch (error) {
    markHoldLookupRequired(hold.id, context)
    throw error
  }
}

async function executeSubscriptionCancel(
  context: FabricExecutionContext,
  account: LifeSourceAccount,
  provider: LifeSubscriptionAdapter,
): Promise<FabricJsonObject> {
  let cancellation = createLifeSubscriptionCancellation({ workflowId: context.workflowId,
    intentId: context.intentId, accountId: account.id, subscriptionId: String(context.input.subscriptionId),
    providerRequestId: String(context.input.providerRequestId), reasonCode: String(context.input.reasonCode),
    createdAt: executionTime(context) })
  if (cancellation.subscriptionDigest !== context.input.subscriptionDigest) {
    throw new LifeContractError('LIFE_SUBSCRIPTION_MATERIAL_MISMATCH')
  }
  const subscription = getLifeSubscription(cancellation.subscriptionId)!
  const request = { providerRequestId: cancellation.providerRequestId,
    providerSubscriptionId: subscription.providerSubscriptionId, reasonCode: cancellation.reasonCode }
  try {
    if (cancellation.state === 'cancelled' || cancellation.state === 'rejected') {
      return subscriptionOutput(context, cancellation)
    }
    if (cancellation.state === 'requested') {
      cancellation = transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
        expectedVersion: cancellation.version, state: 'submitting', updatedAt: executionTime(context) })
    }
    if (cancellation.state === 'lookup_required') {
      const lookup = await provider.lookupSubscriptionCancellation(request)
      if (lookup.status === 'cancelled' || lookup.status === 'rejected') {
        cancellation = finalizeSubscriptionCancellation(cancellation.id, lookup, context)
        return subscriptionOutput(context, cancellation)
      }
      cancellation = transitionLifeSubscriptionCancellation({ cancellationId: cancellation.id,
        expectedVersion: cancellation.version, state: 'submitting', updatedAt: executionTime(context) })
    }
    if (cancellation.state !== 'submitting') throw new LifeContractError('LIFE_CANCELLATION_STATE_INVALID')
    const result = await provider.cancelSubscription(request)
    const lookup = await provider.lookupSubscriptionCancellation(request)
    if (result.status !== lookup.status || result.providerReceiptId !== lookup.providerReceiptId
      || result.receiptDigest !== lookup.receiptDigest || !['cancelled', 'rejected'].includes(result.status)) {
      throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
    }
    cancellation = finalizeSubscriptionCancellation(cancellation.id, result, context)
    return subscriptionOutput(context, cancellation)
  } catch (error) {
    markCancellationLookupRequired(cancellation.id, context)
    throw error
  }
}

/** Verification recovery is lookup-only: it may reconcile durable local state, but never repeat a provider write. */
async function recoverUncertainOutput(
  context: FabricExecutionContext,
  binding: LifeExecutionBinding,
): Promise<FabricJsonObject | null> {
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CREATE_CAPABILITY) {
    const hold = getLifeCalendarHoldByWorkflow(context.workflowId)
    if (!hold || hold.state !== 'lookup_required') return null
    const lookup = await requiredCalendar(binding).lookupCalendarHold({ providerRequestId: hold.providerRequestId })
    if (lookup.status !== 'confirmed' || !lookup.providerHoldId || !lookup.receiptDigest) return null
    const confirmed = confirmHold(hold.id, lookup.providerHoldId, lookup.receiptDigest, context)
    return calendarOutput(context, confirmed, 'calendar_hold_create', lookup.receiptDigest)
  }
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    const hold = getLifeCalendarHold(String(context.input.holdId))
    if (!hold || hold.state !== 'lookup_required' || !hold.providerHoldId) return null
    const lookup = await requiredCalendar(binding).lookupCalendarCancellation({
      providerRequestId: String(context.input.providerRequestId), providerHoldId: hold.providerHoldId,
    })
    if (lookup.status !== 'cancelled' || lookup.providerHoldId !== hold.providerHoldId || !lookup.receiptDigest) {
      return null
    }
    const cancelled = cancelHold(hold.id, context)
    checkpointHold(cancelled.id, 'provider_cancelled', lookup.receiptDigest, context)
    return calendarOutput(context, cancelled, 'calendar_hold_cancel', lookup.receiptDigest)
  }
  if (context.capabilityId === LIFE_SUBSCRIPTION_CANCEL_CAPABILITY) {
    const cancellation = getLifeSubscriptionCancellationByWorkflow(context.workflowId)
    const subscription = cancellation ? getLifeSubscription(cancellation.subscriptionId) : null
    if (!cancellation || cancellation.state !== 'lookup_required' || !subscription) return null
    const lookup = await requiredSubscription(binding).lookupSubscriptionCancellation({
      providerRequestId: cancellation.providerRequestId,
      providerSubscriptionId: subscription.providerSubscriptionId,
    })
    if (!['cancelled', 'rejected'].includes(lookup.status) || !lookup.providerReceiptId || !lookup.receiptDigest) {
      return null
    }
    const finalized = finalizeSubscriptionCancellation(cancellation.id, lookup, context)
    return subscriptionOutput(context, finalized)
  }
  return null
}

async function currentOutput(
  context: FabricExecutionContext,
  binding: LifeExecutionBinding,
): Promise<FabricJsonObject | null> {
  if (context.capabilityId === LIFE_SOURCE_SYNC_CAPABILITY) {
    const output = context.executionOutput
    const account = binding.account
    const ids = output?.recordIds
    if (!account || !output || !Array.isArray(ids) || ids.length > Number(context.input.limit)
      || ids.some(id => typeof id !== 'string' || !recordBelongsToAccount(id, account.id))) return null
    return { schemaVersion: 1, operation: 'source_sync', accountId: account.id, sourceKind: account.sourceKind,
      status: output.nextCursor === null ? 'succeeded' : 'partial', recordIds: ids,
      totalCount: ids.length, nextCursor: output.nextCursor ?? null }
  }
  if (context.capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) return planVerificationOutput(context)
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CREATE_CAPABILITY) {
    const hold = getLifeCalendarHoldByWorkflow(context.workflowId)
    const provider = requiredCalendar(binding)
    if (!hold || hold.state !== 'confirmed') return null
    const lookup = await provider.lookupCalendarHold({ providerRequestId: hold.providerRequestId })
    if (lookup.status !== 'confirmed' || lookup.providerHoldId !== hold.providerHoldId
      || lookup.receiptDigest !== hold.receiptDigest) return null
    return calendarOutput(context, hold, 'calendar_hold_create', lookup.receiptDigest)
  }
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    const hold = getLifeCalendarHold(String(context.input.holdId))
    const provider = requiredCalendar(binding)
    if (!hold || hold.state !== 'cancelled') return null
    const lookup = await provider.lookupCalendarCancellation({
      providerRequestId: String(context.input.providerRequestId), providerHoldId: String(context.input.providerHoldId),
    })
    if (lookup.status !== 'cancelled' || lookup.providerHoldId !== hold.providerHoldId) return null
    return calendarOutput(context, hold, 'calendar_hold_cancel', lookup.receiptDigest)
  }
  const cancellationId = context.executionOutput?.cancellationId
  const cancellation = typeof cancellationId === 'string' ? getLifeSubscriptionCancellation(cancellationId) : null
  const subscription = cancellation ? getLifeSubscription(cancellation.subscriptionId) : null
  const provider = requiredSubscription(binding)
  if (!cancellation || !subscription || !['cancelled', 'rejected'].includes(cancellation.state)) return null
  const lookup = await provider.lookupSubscriptionCancellation({ providerRequestId: cancellation.providerRequestId,
    providerSubscriptionId: subscription.providerSubscriptionId })
  if (lookup.status !== cancellation.state || lookup.providerReceiptId !== cancellation.providerReceiptId
    || lookup.receiptDigest !== cancellation.receiptDigest) return null
  return subscriptionOutput(context, cancellation)
}

function assertContext(
  options: LifeExecutorOptions,
  context: FabricExecutionContext,
  preparing: boolean,
): LifeExecutionBinding {
  if (context.executorId !== options.id || context.executorType !== 'connector'
    || !isLifeFabricCapability(context.capabilityId)
    || !validateLifeFabricSemantics(context.capabilityId, context.input)
    || lifeTargetAtoms(context.capabilityId, context.target, context.input) === null) {
    throw new LifeContractError('LIFE_EXECUTOR_CONTEXT_INVALID')
  }
  if (context.capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) {
    assertPlanMaterial(context)
    return { account: null, provider: null, mode: 'read', policyEpoch: 0 }
  }
  const account = getLifeSourceAccount(String(context.input.accountId))
  if (!account || !account.enabled || account.health === 'revoked' || account.health === 'unhealthy'
    || account.executorId !== null && account.executorId !== options.id
    || context.input.sourceKind !== undefined && account.sourceKind !== context.input.sourceKind
    || context.capabilityId.startsWith('life.calendar.') && account.sourceKind !== 'calendar'
    || context.capabilityId === LIFE_SUBSCRIPTION_CANCEL_CAPABILITY && account.sourceKind !== 'subscriptions'
    || !READ_CAPABILITIES.has(context.capabilityId) && account.mode === 'observe') {
    throw new LifeContractError('LIFE_ACCOUNT_UNAVAILABLE')
  }
  const provider = options.providerForAccount(account.id)
  if (!provider || provider.sourceKind !== account.sourceKind
    || account.mode === 'shadow' && provider.transport !== 'virtual'
    || account.mode === 'live' && provider.transport !== 'external') {
    throw new LifeContractError('LIFE_PROVIDER_UNAVAILABLE')
  }
  if (preparing && context.capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    const hold = requiredHold(String(context.input.holdId), account.id)
    if (hold.version !== context.input.expectedVersion || hold.state !== 'confirmed') {
      throw new LifeContractError('LIFE_CALENDAR_HOLD_MATERIAL_MISMATCH')
    }
  }
  return { account, provider, mode: account.mode, policyEpoch: account.policyEpoch }
}

function assertBoundMaterial(
  context: FabricExecutionContext,
  binding: LifeExecutionBinding,
  preparing: boolean,
): void {
  if (context.capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) { assertPlanMaterial(context); return }
  const account = requiredAccount(binding)
  if (context.capabilityId === LIFE_SOURCE_SYNC_CAPABILITY) return
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CREATE_CAPABILITY) {
    const plan = assertCalendarPlanMaterial(context)
    const takeover = getLifeCalendarHoldByWorkflow(context.workflowId)
    if (takeover) {
      if (takeover.accountId !== account.id || takeover.planRevisionId !== plan.id
        || takeover.planDigest !== plan.planDigest || takeover.optionId !== context.input.optionId
        || takeover.providerRequestId !== context.input.providerRequestId
        || takeover.window.startsAt !== context.input.startsAt || takeover.window.endsAt !== context.input.endsAt) {
        throw new LifeContractError('LIFE_CALENDAR_HOLD_REPLAY_MISMATCH')
      }
    } else {
      const verification = verifyLifePlanRevision({ planId: plan.id, activeAt: executionTime(context) })
      if (!verification.valid) throw new LifeContractError('LIFE_PLAN_STALE')
    }
    if (!plan.sessions.some(session => session.optionId === context.input.optionId
      && session.startsAt === context.input.startsAt && session.endsAt === context.input.endsAt)) {
      throw new LifeContractError('LIFE_PLAN_SESSION_MATERIAL_MISMATCH')
    }
    return
  }
  if (context.capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    const hold = requiredHold(String(context.input.holdId), account.id)
    if (hold.planRevisionId !== context.input.planRevisionId || hold.planDigest !== context.input.planDigest
      || hold.providerHoldId !== context.input.providerHoldId
      || preparing && hold.version !== context.input.expectedVersion) {
      throw new LifeContractError('LIFE_CALENDAR_HOLD_MATERIAL_MISMATCH')
    }
    return
  }
  const takeover = getLifeSubscriptionCancellationByWorkflow(context.workflowId)
  if (takeover) {
    if (takeover.accountId !== account.id || takeover.subscriptionId !== context.input.subscriptionId
      || takeover.subscriptionDigest !== context.input.subscriptionDigest
      || takeover.providerRequestId !== context.input.providerRequestId
      || takeover.reasonCode !== context.input.reasonCode) {
      throw new LifeContractError('LIFE_SUBSCRIPTION_CANCELLATION_REPLAY_MISMATCH')
    }
    return
  }
  const subscription = getLifeSubscription(String(context.input.subscriptionId))
  if (!subscription || subscription.accountId !== account.id
    || lifeSubscriptionMaterialDigest(subscription) !== context.input.subscriptionDigest
    || subscription.recurringCost.currency !== context.input.currency) {
    throw new LifeContractError('LIFE_SUBSCRIPTION_MATERIAL_MISMATCH')
  }
}

function assertCalendarPlanMaterial(context: FabricExecutionContext): NonNullable<ReturnType<typeof getLifePlanRevision>> {
  const plan = getLifePlanRevision(String(context.input.planRevisionId))
  const constraint = plan ? getLifeConstraintSnapshot(plan.constraintSnapshotId) : null
  if (!plan || !constraint || plan.planDigest !== context.input.planDigest
    || constraint.materialDigest !== plan.constraintDigest || plan.totalCost.currency !== context.input.currency) {
    throw new LifeContractError('LIFE_PLAN_MATERIAL_MISMATCH')
  }
  return plan
}

function assertPlanMaterial(context: FabricExecutionContext): void {
  const plan = getLifePlanRevision(String(context.input.planRevisionId))
  const constraint = plan ? getLifeConstraintSnapshot(plan.constraintSnapshotId) : null
  if (!plan || !constraint || plan.planDigest !== context.input.planDigest
    || plan.constraintSnapshotId !== context.input.constraintSnapshotId
    || plan.constraintDigest !== context.input.constraintDigest
    || constraint.materialDigest !== plan.constraintDigest
    || plan.totalCost.currency !== context.input.currency) {
    throw new LifeContractError('LIFE_PLAN_MATERIAL_MISMATCH')
  }
}

function planVerificationOutput(context: FabricExecutionContext): FabricJsonObject {
  assertPlanMaterial(context)
  const verification = verifyLifePlanRevision({ planId: String(context.input.planRevisionId),
    activeAt: String(context.input.activeAt) })
  return { schemaVersion: 1, operation: 'plan_verify', planRevisionId: context.input.planRevisionId,
    planDigest: context.input.planDigest, constraintSnapshotId: context.input.constraintSnapshotId,
    constraintDigest: context.input.constraintDigest, currency: context.input.currency,
    valid: verification.valid, reasonCodes: verification.reasonCodes, checkedAt: verification.checkedAt }
}

function matchesPrepared(context: FabricExecutionContext, binding: LifeExecutionBinding): boolean {
  return context.preparedOutput?.schemaVersion === 1
    && context.preparedOutput.accountId === (binding.account?.id ?? null)
    && context.preparedOutput.capabilityId === context.capabilityId
    && context.preparedOutput.materialDigest === materialDigest(context)
    && context.preparedOutput.mode === binding.mode
    && context.preparedOutput.policyEpoch === binding.policyEpoch
}

function confirmHold(holdId: string, providerHoldId: string, receiptDigest: string,
  context: FabricExecutionContext) {
  const current = getLifeCalendarHold(holdId)!
  const hold = transitionLifeCalendarHold({ holdId, expectedVersion: current.version, state: 'confirmed',
    providerHoldId, receiptDigest, completedAt: executionTime(context), updatedAt: executionTime(context) })
  checkpointHold(hold.id, 'provider_confirmed', receiptDigest, context)
  return hold
}

function cancelHold(holdId: string, context: FabricExecutionContext) {
  const current = getLifeCalendarHold(holdId)!
  return transitionLifeCalendarHold({ holdId, expectedVersion: current.version, state: 'cancelled',
    completedAt: executionTime(context), updatedAt: executionTime(context) })
}

function markHoldLookupRequired(holdId: string, context: FabricExecutionContext): void {
  const current = getLifeCalendarHold(holdId)
  if (current && (current.state === 'submitting' || current.state === 'cancelling')) {
    transitionLifeCalendarHold({ holdId, expectedVersion: current.version, state: 'lookup_required',
      updatedAt: executionTime(context) })
  }
}

function markCancellationLookupRequired(cancellationId: string, context: FabricExecutionContext): void {
  const current = getLifeSubscriptionCancellation(cancellationId)
  if (current && (current.state === 'submitting' || current.state === 'processing')) {
    transitionLifeSubscriptionCancellation({ cancellationId, expectedVersion: current.version,
      state: 'lookup_required', updatedAt: executionTime(context) })
  }
}

function finalizeSubscriptionCancellation(cancellationId: string, result: {
  status: 'not_found' | 'cancelled' | 'rejected'
  providerReceiptId: string | null
  receiptDigest: string | null
}, context: FabricExecutionContext) {
  if (result.status === 'not_found') throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
  const current = getLifeSubscriptionCancellation(cancellationId)!
  const cancellation = transitionLifeSubscriptionCancellation({ cancellationId, expectedVersion: current.version,
    state: result.status, providerReceiptId: result.providerReceiptId, receiptDigest: result.receiptDigest,
    completedAt: executionTime(context), updatedAt: executionTime(context) })
  if (result.receiptDigest) appendLifeCheckpoint({ aggregateKind: 'subscription_cancellation',
    aggregateId: cancellation.id, stage: `provider_${result.status}`, evidenceDigest: result.receiptDigest,
    details: { providerState: result.status }, observedAt: executionTime(context) })
  return cancellation
}

function checkpointHold(holdId: string, stage: string, receiptDigest: string,
  context: FabricExecutionContext): void {
  appendLifeCheckpoint({ aggregateKind: 'calendar_hold', aggregateId: holdId, stage,
    evidenceDigest: receiptDigest, details: { providerState: stage }, observedAt: executionTime(context) })
}

async function compensateCalendarHold(
  context: FabricExecutionContext,
  binding: LifeExecutionBinding,
): Promise<FabricJsonObject> {
  const provider = requiredCalendar(binding)
  let hold = getLifeCalendarHoldByWorkflow(context.workflowId)
  if (!hold || !hold.providerHoldId) throw new LifeContractError('LIFE_CALENDAR_HOLD_NOT_FOUND')
  const providerRequestId = `compensate-${digest(context.workflowId).slice(0, 40)}`
  const request = { providerRequestId, providerHoldId: hold.providerHoldId,
    reasonCode: 'VERIFICATION_MISMATCH' }
  if (hold.state === 'confirmed') hold = transitionLifeCalendarHold({ holdId: hold.id,
    expectedVersion: hold.version, state: 'cancel_requested', updatedAt: executionTime(context) })
  if (hold.state === 'cancel_requested') hold = transitionLifeCalendarHold({ holdId: hold.id,
    expectedVersion: hold.version, state: 'cancelling', updatedAt: executionTime(context) })
  const result = hold.state === 'cancelled'
    ? await provider.lookupCalendarCancellation(request) : await provider.cancelCalendarHold(request)
  const lookup = await provider.lookupCalendarCancellation(request)
  if (result.status !== 'cancelled' || lookup.status !== 'cancelled'
    || result.receiptDigest !== lookup.receiptDigest) throw new LifeContractError('LIFE_PROVIDER_VERIFICATION_MISMATCH')
  if (hold.state !== 'cancelled') hold = cancelHold(hold.id, context)
  checkpointHold(hold.id, 'provider_compensated', lookup.receiptDigest!, context)
  return { schemaVersion: 1, holdId: hold.id, providerRequestId,
    receiptDigest: lookup.receiptDigest, state: 'cancelled' }
}

function calendarOutput(context: FabricExecutionContext, hold: NonNullable<ReturnType<typeof getLifeCalendarHold>>,
  operation: 'calendar_hold_create' | 'calendar_hold_cancel', receiptDigest: string | null): FabricJsonObject {
  return { schemaVersion: 1, operation, accountId: hold.accountId, planRevisionId: hold.planRevisionId,
    planDigest: hold.planDigest, providerRequestId: context.input.providerRequestId, holdId: hold.id,
    optionId: hold.optionId, providerHoldId: hold.providerHoldId, receiptDigest,
    currency: context.input.currency, state: hold.state }
}

function subscriptionOutput(context: FabricExecutionContext,
  cancellation: NonNullable<ReturnType<typeof getLifeSubscriptionCancellation>>): FabricJsonObject {
  return { schemaVersion: 1, operation: 'subscription_cancel', accountId: cancellation.accountId,
    subscriptionId: cancellation.subscriptionId, subscriptionDigest: cancellation.subscriptionDigest,
    cancellationId: cancellation.id, providerRequestId: cancellation.providerRequestId,
    providerReceiptId: cancellation.providerReceiptId, receiptDigest: cancellation.receiptDigest,
    currency: context.input.currency, state: cancellation.state }
}

function requiredAccount(binding: LifeExecutionBinding): LifeSourceAccount {
  if (!binding.account) throw new LifeContractError('LIFE_ACCOUNT_UNAVAILABLE')
  return binding.account
}

function requiredProvider(binding: LifeExecutionBinding): LifeSourceAdapter {
  if (!binding.provider) throw new LifeContractError('LIFE_PROVIDER_UNAVAILABLE')
  return binding.provider
}

function requiredCalendar(binding: LifeExecutionBinding): LifeCalendarAdapter {
  const provider = requiredProvider(binding) as LifeCalendarAdapter
  if (provider.sourceKind !== 'calendar' || typeof provider.createCalendarHold !== 'function'
    || typeof provider.lookupCalendarHold !== 'function' || typeof provider.cancelCalendarHold !== 'function'
    || typeof provider.lookupCalendarCancellation !== 'function') {
    throw new LifeContractError('LIFE_PROVIDER_UNAVAILABLE')
  }
  return provider
}

function requiredSubscription(binding: LifeExecutionBinding): LifeSubscriptionAdapter {
  const provider = requiredProvider(binding) as LifeSubscriptionAdapter
  if (provider.sourceKind !== 'subscriptions' || typeof provider.cancelSubscription !== 'function'
    || typeof provider.lookupSubscriptionCancellation !== 'function') {
    throw new LifeContractError('LIFE_PROVIDER_UNAVAILABLE')
  }
  return provider
}

function requiredHold(holdId: string, accountId: string) {
  const hold = getLifeCalendarHold(holdId)
  if (!hold || hold.accountId !== accountId) throw new LifeContractError('LIFE_CALENDAR_HOLD_NOT_FOUND')
  return hold
}

function recordBelongsToAccount(id: string, accountId: string): boolean {
  if (id.startsWith('commitment-')) return getLifeCommitment(id)?.accountId === accountId
  if (id.startsWith('contact-')) return getLifeContactAlias(id)?.accountId === accountId
  if (id.startsWith('option-')) return getLifeOption(id)?.accountId === accountId
  if (id.startsWith('subscription-')) return getLifeSubscription(id)?.accountId === accountId
  return false
}

function materialDigest(context: FabricExecutionContext): string {
  return digest(canonical({ workflowId: context.workflowId, intentId: context.intentId,
    executorId: context.executorId, capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion, contractDigest: context.contractDigest,
    policyEvaluationToken: context.policyEvaluationToken, input: context.input, target: context.target }))
}

function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: evidence(context, output), errorCode: null, safeToRetry: false }
}

function evidence(context: FabricExecutionContext, output: FabricJsonObject): FabricEvidence[] {
  return [{ kind: 'life_receipt', summary: `Life ${context.capabilityId} receipt`, data: {
    capabilityId: context.capabilityId, materialDigest: materialDigest(context),
    outputDigest: digest(canonical(output)),
    ...(typeof output.holdId === 'string' ? { holdId: output.holdId } : {}),
    ...(typeof output.cancellationId === 'string' ? { cancellationId: output.cancellationId } : {}),
  }, capturedAt: executionTime(context) }]
}

function executeFailure(error: unknown): FabricExecuteResult {
  const code = errorCode(error, 'LIFE_EXECUTION_FAILED')
  if (error instanceof LifeProviderError) {
    if (error.uncertain) return failure('unknown', code)
    if (error.retryable) return failure('temporary_failure', code, true)
  }
  return failure('permanent_failure', code)
}

function failure<T extends string>(outcome: T, code: string, safeToRetry = false) {
  return { outcome, output: {}, evidence: [], errorCode: code, safeToRetry }
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const value = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value)) return value
  }
  return fallback
}

function executionTime(context: FabricExecutionContext): string {
  if (context.now && new Date(context.now).toISOString() === context.now) return context.now
  return new Date().toISOString()
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compare).map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
