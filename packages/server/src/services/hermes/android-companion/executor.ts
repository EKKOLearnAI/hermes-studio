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
import {
  ANDROID_APP_LAUNCH_CAPABILITY,
  ANDROID_SCREEN_CAPTURE_CAPABILITY,
  androidTargetAtoms,
  isAndroidFabricCapability,
  validateAndroidOutputSemantics,
  validateAndroidSemantics,
} from './fabric-contracts'
import type { AndroidCompanionCommandBridge, AndroidCommandBridgeOutcome } from './command-bridge'
import type { AndroidCompanionStore } from './store'
import type { AndroidExecutionReceipt } from './types'

const EXECUTOR_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/
const FRESH_OBSERVATION_MS = 2 * 60_000

export interface AndroidCompanionExecutorOptions {
  id: string
  deviceId: string
  capabilityId: typeof ANDROID_APP_LAUNCH_CAPABILITY | typeof ANDROID_SCREEN_CAPTURE_CAPABILITY
  store: AndroidCompanionStore
  bridge: AndroidCompanionCommandBridge
  now?: () => Date
}

export function createAndroidCompanionExecutorAdapter(
  options: AndroidCompanionExecutorOptions,
): FabricExecutorAdapter {
  if (!EXECUTOR_ID.test(options.id) || !/^hwui_[A-Za-z0-9_-]{32}$/.test(options.deviceId)
    || !isAndroidFabricCapability(options.capabilityId)) {
    throw new Error('ANDROID_EXECUTOR_CONFIGURATION_INVALID')
  }
  const now = options.now ?? (() => new Date())
  return {
    id: options.id,
    type: 'android',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        assertContext(options, context)
        const digest = materialDigest(context)
        options.store.prepareReceipt({
          workflowId: context.workflowId,
          intentId: context.intentId,
          materialDigest: digest,
          deviceId: options.deviceId,
          capabilityId: context.capabilityId,
          capabilityVersion: context.capabilityVersion,
          target: context.target,
        })
        return success('prepared', context, {
          materialDigest: digest,
          deviceId: options.deviceId,
          capabilityId: context.capabilityId,
        })
      } catch (error) {
        return failure('failed', prepareError(error))
      }
    },

    async execute(context): Promise<FabricExecuteResult> {
      let digest: string
      let receipt: AndroidExecutionReceipt
      try {
        assertContext(options, context)
        digest = materialDigest(context)
        if (!matchesPrepared(context, digest, options)) {
          return failure('permanent_failure', 'ANDROID_PREPARATION_INVALID')
        }
        receipt = requiredReceipt(options.store, context.workflowId, digest)
        if (receipt.status === 'verified' && receipt.result) return success('succeeded', context, receipt.result)
        if (receipt.status === 'executed' && receipt.result) return success('succeeded', context, receipt.result)
        if (['failed', 'mismatch'].includes(receipt.status)) {
          return failure('permanent_failure', receipt.errorCode ?? 'ANDROID_PREVIOUSLY_FAILED')
        }
      } catch {
        return failure('permanent_failure', 'ANDROID_RECEIPT_INVALID')
      }

      const commandId = durableCommandId(context, executionKind(context.capabilityId))
      try {
        const queued = options.store.queueCommand({
          id: commandId,
          workflowId: context.workflowId,
          executionToken: context.executionToken,
          materialDigest: digest,
          deviceId: options.deviceId,
          capabilityId: context.capabilityId,
          capabilityVersion: context.capabilityVersion,
          kind: executionKind(context.capabilityId),
          payload: context.input,
          expiresAt: new Date(now().getTime() + 2 * 60_000).toISOString(),
        }).command
        receipt = ensureExecutingReceipt(options.store, receipt, queued.id)
      } catch {
        return failure('permanent_failure', 'ANDROID_COMMAND_PREPARATION_FAILED')
      }

      const outcome = await options.bridge.execute(commandId)
      return applyExecuteOutcome(options.store, receipt, context, outcome)
    },

    async verify(context): Promise<FabricVerifyResult> {
      let digest: string
      let receipt: AndroidExecutionReceipt
      let executionResult: FabricJsonObject
      try {
        assertContext(options, context)
        digest = materialDigest(context)
        if (!matchesPrepared(context, digest, options)) throw new Error('prepared mismatch')
        receipt = requiredReceipt(options.store, context.workflowId, digest)
        if (receipt.status === 'verified' && receipt.result) return success('verified', context, receipt.result)
        if (!receipt.result || !context.executionOutput || !isDeepStrictEqual(receipt.result, context.executionOutput)
          || !validateAndroidOutputSemantics(context.capabilityId, context.input, receipt.result)) {
          return failure('failed', 'ANDROID_EXECUTION_RESULT_INVALID')
        }
        executionResult = receipt.result
        if (receipt.status === 'executed' || receipt.status === 'unknown') {
          receipt = options.store.transitionReceipt({
            workflowId: receipt.workflowId,
            materialDigest: receipt.materialDigest,
            expectedVersion: receipt.version,
            status: 'verifying',
          })
        }
        if (receipt.status !== 'verifying') return failure('failed', 'ANDROID_RECEIPT_INVALID')
      } catch {
        return failure('failed', 'ANDROID_VERIFICATION_PREPARATION_INVALID')
      }

      if (context.capabilityId === ANDROID_SCREEN_CAPTURE_CAPABILITY) {
        return completeLocalCaptureVerification(options.store, receipt, context, now())
      }

      const verificationCommandId = durableCommandId(context, 'foreground_verify')
      try {
        options.store.queueCommand({
          id: verificationCommandId,
          workflowId: context.workflowId,
          executionToken: context.executionToken,
          materialDigest: digest,
          deviceId: options.deviceId,
          capabilityId: context.capabilityId,
          capabilityVersion: context.capabilityVersion,
          kind: 'foreground_verify',
          payload: {
            appBinding: context.input.appBinding,
            packageFingerprint: context.input.packageFingerprint,
            observedAfter: String(executionResult.observedAt),
          },
          expiresAt: new Date(now().getTime() + 60_000).toISOString(),
        })
      } catch {
        return markVerificationFailure(options.store, receipt, context, 'ANDROID_VERIFICATION_COMMAND_INVALID')
      }
      const outcome = await options.bridge.execute(verificationCommandId)
      if (outcome.outcome !== 'succeeded') {
        if (outcome.outcome === 'waiting_user') {
          markReceiptWaiting(options.store, receipt, outcome.errorCode)
          return failure('unknown', outcome.errorCode)
        }
        if (outcome.outcome === 'temporary_failure' || outcome.outcome === 'unknown') {
          markReceiptUnknown(options.store, receipt, outcome.errorCode)
          return failure('unknown', outcome.errorCode)
        }
        return markVerificationFailure(options.store, receipt, context, outcome.errorCode)
      }
      const verification = outcome.output
      const matches = validateAndroidOutputSemantics(context.capabilityId, context.input, verification)
        && freshTimestamp(verification.observedAt, now())
        && Date.parse(String(verification.observedAt)) > Date.parse(String(executionResult.observedAt))
      if (!matches) return markVerificationMismatch(options.store, receipt, context, 'ANDROID_FOREGROUND_MISMATCH')
      return completeVerified(options.store, receipt, context, verification)
    },

    async interrupt(context): Promise<FabricInterruptResult> {
      try {
        assertContext(options, context)
        const command = options.store.getCommand(durableCommandId(context, executionKind(context.capabilityId)))
        if (!command) return success('interrupted', context, { commandState: 'not_created' })
        const outcome = await options.bridge.cancel(command.id)
        return outcome.outcome === 'cancelled'
          ? success('interrupted', context, { commandId: command.id, commandState: 'cancelled' })
          : failure('unknown', 'errorCode' in outcome ? outcome.errorCode : 'ANDROID_CANCEL_UNCONFIRMED')
      } catch {
        return failure('failed', 'ANDROID_INTERRUPT_FAILED')
      }
    },

    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'ANDROID_COMPENSATION_UNSUPPORTED')
    },
  }
}

function assertContext(options: AndroidCompanionExecutorOptions, context: FabricExecutionContext): void {
  if (context.executorId !== options.id || context.executorType !== 'android'
    || context.capabilityId !== options.capabilityId || !validateAndroidSemantics(context.capabilityId, context.input)
    || androidTargetAtoms(context.capabilityId, context.target, context.input) === null
    || context.target.deviceId !== options.deviceId) throw new Error('ANDROID_CONTEXT_INVALID')
}

function matchesPrepared(
  context: FabricExecutionContext,
  digest: string,
  options: AndroidCompanionExecutorOptions,
): boolean {
  return context.preparedOutput?.materialDigest === digest
    && context.preparedOutput.deviceId === options.deviceId
    && context.preparedOutput.capabilityId === context.capabilityId
}

function materialDigest(context: FabricExecutionContext): string {
  return hash({
    workflowId: context.workflowId,
    intentId: context.intentId,
    executorId: context.executorId,
    capabilityId: context.capabilityId,
    capabilityVersion: context.capabilityVersion,
    contractDigest: context.contractDigest,
    input: context.input,
    target: context.target,
  })
}

function durableCommandId(context: FabricExecutionContext, kind: string): string {
  return `command-${hash({ workflowId: context.workflowId, executionToken: context.executionToken,
    materialDigest: materialDigest(context), kind }).slice(0, 40)}`
}

function executionKind(capabilityId: string): 'app_launch' | 'screen_capture' {
  return capabilityId === ANDROID_APP_LAUNCH_CAPABILITY ? 'app_launch' : 'screen_capture'
}

function ensureExecutingReceipt(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  commandId: string,
): AndroidExecutionReceipt {
  if (receipt.status === 'prepared' || receipt.status === 'unknown' || receipt.status === 'waiting_user') {
    return store.transitionReceipt({
      workflowId: receipt.workflowId,
      materialDigest: receipt.materialDigest,
      expectedVersion: receipt.version,
      status: 'executing',
      commandId,
    })
  }
  if (receipt.status !== 'executing' || receipt.commandId !== commandId) throw new Error('invalid receipt state')
  return receipt
}

function applyExecuteOutcome(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  context: FabricExecutionContext,
  outcome: AndroidCommandBridgeOutcome,
): FabricExecuteResult {
  if (outcome.outcome === 'succeeded') {
    if (!validateAndroidOutputSemantics(context.capabilityId, context.input, outcome.output)) {
      return markExecutionFailure(store, receipt, 'ANDROID_COMMAND_RESULT_INVALID')
    }
    const completed = store.transitionReceipt({
      workflowId: receipt.workflowId,
      materialDigest: receipt.materialDigest,
      expectedVersion: receipt.version,
      status: 'executed',
      result: outcome.output,
    })
    return success('succeeded', context, completed.result ?? outcome.output)
  }
  if (outcome.outcome === 'temporary_failure') {
    markReceiptUnknown(store, receipt, outcome.errorCode)
    return failure('temporary_failure', outcome.errorCode, true)
  }
  if (outcome.outcome === 'unknown') {
    markReceiptUnknown(store, receipt, outcome.errorCode)
    return failure('unknown', outcome.errorCode)
  }
  if (outcome.outcome === 'waiting_user') {
    markReceiptWaiting(store, receipt, outcome.errorCode)
    return failure('unknown', outcome.errorCode)
  }
  return markExecutionFailure(store, receipt, outcome.errorCode)
}

function completeLocalCaptureVerification(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  context: FabricExecutionContext,
  now: Date,
): FabricVerifyResult {
  if (!receipt.result || !freshTimestamp(receipt.result.capturedAt, now)
    || receipt.result.permissionGrantActive !== true) {
    return markVerificationMismatch(store, receipt, context, 'ANDROID_CAPTURE_NOT_FRESH')
  }
  return completeVerified(store, receipt, context, {
    strategy: 'fresh_capture_digest_dimensions_and_grant',
    captureId: receipt.result.captureId,
    digest: receipt.result.digest,
    verifiedAt: now.toISOString(),
  })
}

function completeVerified(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  context: FabricExecutionContext,
  verification: FabricJsonObject,
): FabricVerifyResult {
  const completed = store.transitionReceipt({
    workflowId: receipt.workflowId,
    materialDigest: receipt.materialDigest,
    expectedVersion: receipt.version,
    status: 'verified',
    result: receipt.result,
    verification,
  })
  return success('verified', context, completed.result ?? {})
}

function markExecutionFailure(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  errorCode: string,
): FabricExecuteResult {
  transitionReceiptError(store, receipt, 'failed', errorCode)
  return failure('permanent_failure', errorCode)
}

function markVerificationFailure(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  _context: FabricExecutionContext,
  errorCode: string,
): FabricVerifyResult {
  transitionReceiptError(store, receipt, 'failed', errorCode)
  return failure('failed', errorCode)
}

function markVerificationMismatch(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  _context: FabricExecutionContext,
  errorCode: string,
): FabricVerifyResult {
  transitionReceiptError(store, receipt, 'mismatch', errorCode)
  return failure('mismatch', errorCode)
}

function markReceiptUnknown(store: AndroidCompanionStore, receipt: AndroidExecutionReceipt, errorCode: string): void {
  transitionReceiptError(store, receipt, 'unknown', errorCode)
}

function markReceiptWaiting(store: AndroidCompanionStore, receipt: AndroidExecutionReceipt, errorCode: string): void {
  transitionReceiptError(store, receipt, 'waiting_user', errorCode)
}

function transitionReceiptError(
  store: AndroidCompanionStore,
  receipt: AndroidExecutionReceipt,
  status: 'unknown' | 'waiting_user' | 'failed' | 'mismatch',
  errorCode: string,
): AndroidExecutionReceipt {
  const current = store.getReceipt(receipt.workflowId) ?? receipt
  if (['verified', 'failed', 'mismatch'].includes(current.status)) return current
  return store.transitionReceipt({
    workflowId: current.workflowId,
    materialDigest: current.materialDigest,
    expectedVersion: current.version,
    status,
    errorCode,
  })
}

function requiredReceipt(store: AndroidCompanionStore, workflowId: string, digest: string): AndroidExecutionReceipt {
  const receipt = store.getReceipt(workflowId)
  if (!receipt || receipt.materialDigest !== digest) throw new Error('ANDROID_RECEIPT_INVALID')
  return receipt
}

function freshTimestamp(value: unknown, now: Date): boolean {
  if (typeof value !== 'string' || value.length !== 24) return false
  try {
    if (new Date(value).toISOString() !== value) return false
  } catch {
    return false
  }
  const age = now.getTime() - Date.parse(value)
  return age >= -30_000 && age <= FRESH_OBSERVATION_MS
}

function prepareError(error: unknown): string {
  return error instanceof Error && /unavailable|revoked/i.test(error.message)
    ? 'ANDROID_CAPABILITY_UNAVAILABLE' : 'ANDROID_CONTEXT_INVALID'
}

function success<T extends 'prepared' | 'succeeded' | 'verified' | 'interrupted'>(
  outcome: T,
  context: FabricExecutionContext,
  output: FabricJsonObject,
): T extends 'prepared' ? FabricPrepareResult
  : T extends 'succeeded' ? FabricExecuteResult
    : T extends 'verified' ? FabricVerifyResult : FabricInterruptResult {
  return {
    outcome,
    output,
    evidence: evidence(context, outcome),
    errorCode: null,
    safeToRetry: false,
  } as never
}

function failure<T extends 'failed' | 'permanent_failure' | 'temporary_failure' | 'unknown' | 'mismatch' | 'unsupported'>(
  outcome: T,
  errorCode: string,
  safeToRetry = false,
): any {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry }
}

function evidence(context: FabricExecutionContext, phase: string): FabricEvidence[] {
  return [{
    kind: 'android_receipt',
    summary: `Android ${phase}`,
    data: { workflowId: context.workflowId, capabilityId: context.capabilityId, executorId: context.executorId },
    capturedAt: context.now && canonicalTime(context.now) ? context.now : new Date().toISOString(),
  }]
}

function canonicalTime(value: string): boolean {
  try { return new Date(value).toISOString() === value } catch { return false }
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
