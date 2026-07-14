import { createHash } from 'crypto'
import { isFabricSensitiveString } from '../../action-fabric/audit'
import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'
import type { WeixinReceiptSender, WeixinProviderDelivery } from '../../weixin-sender'

export interface HealthWeixinExecutorOptions { profile: string; sender: WeixinReceiptSender }

const REMINDER_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  eat: '现在最该做：按计划完成这一餐。',
  meal: '现在最该做：按计划完成这一餐。',
  meal_due: '现在最该做：按计划完成这一餐。',
  recovery_check: '现在最该做：完成一次简短恢复检查。',
  training_adjustment: '训练计划已有一项安全调整，请查看并确认。',
})

export function createHealthWeixinExecutorAdapter(options: HealthWeixinExecutorOptions): FabricExecutorAdapter {
  const executions = new Map<string, { materialDigest: string; promise: Promise<FabricExecuteResult> }>()
  return {
    id: 'health-weixin', type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        if (!['health.reminder.send', 'health.checkin.request'].includes(context.capabilityId)
          || context.input.recipient !== 'configured-self' || context.target.recipient !== 'configured-self') throw new Error('invalid')
        const identity = executorIdentity(options)
        const deliveryId = stableDeliveryId(context, identity)
        const message = minimizedMessage(context)
        return success('prepared', context, { deliveryId, profile: identity.profile,
          accountFingerprint: identity.accountFingerprint, messageDigest: createHash('sha256').update(message).digest('hex') })
      } catch { return failure('failed', 'HEALTH_WEIXIN_REQUEST_INVALID') }
    },
    execute(context): Promise<FabricExecuteResult> {
      let deliveryId: string
      let message: string
      try {
        const identity = executorIdentity(options)
        deliveryId = stableDeliveryId(context, identity); message = minimizedMessage(context)
        if (!context.preparedOutput || context.preparedOutput.deliveryId !== deliveryId
          || context.preparedOutput.profile !== identity.profile
          || context.preparedOutput.accountFingerprint !== identity.accountFingerprint
          || context.preparedOutput.messageDigest !== createHash('sha256').update(message).digest('hex')) throw new Error('invalid')
      } catch { return Promise.resolve(failure('permanent_failure', 'HEALTH_WEIXIN_PREPARATION_INVALID')) }
      const materialDigest = createHash('sha256').update(JSON.stringify({ deliveryId, message })).digest('hex')
      const existing = executions.get(context.executionToken)
      if (existing) return existing.materialDigest === materialDigest ? existing.promise
        : Promise.resolve(failure('permanent_failure', 'HEALTH_WEIXIN_EXECUTION_TOKEN_CONFLICT'))
      const promise = executeDelivery(options.sender, context, deliveryId, message)
      executions.set(context.executionToken, { materialDigest, promise })
      promise.then(() => {
        if (executions.get(context.executionToken)?.promise === promise) executions.delete(context.executionToken)
      }, () => {
        if (executions.get(context.executionToken)?.promise === promise) executions.delete(context.executionToken)
      })
      return promise
    },
    async verify(context): Promise<FabricVerifyResult> {
      const deliveryId = context.executionOutput?.deliveryId
      const executionOutput = context.executionOutput
      let expectedDeliveryId: string
      try { expectedDeliveryId = stableDeliveryId(context, executorIdentity(options)) }
      catch { return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE') }
      if (typeof deliveryId !== 'string' || deliveryId !== expectedDeliveryId
        || !executionOutput
        || ((executionOutput.status === 'accepted' || executionOutput.status === 'delivered')
          && !validProviderIdentity(executionOutput.providerMessageId))) {
        return failure('failed', 'HEALTH_WEIXIN_VERIFICATION_INVALID')
      }
      let status: Awaited<ReturnType<WeixinReceiptSender['lookup']>>
      try { status = await options.sender.lookup(deliveryId) } catch {
        return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE')
      }
      return (status.status === 'accepted' || status.status === 'delivered') && validProviderIdentity(status.providerMessageId)
        ? success('verified', context, { deliveryId, providerMessageId: status.providerMessageId })
        : failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE')
    },
    async interrupt(): Promise<FabricInterruptResult> {
      return failure('unsupported', 'HEALTH_WEIXIN_INTERRUPT_UNSUPPORTED')
    },
    async compensate(): Promise<FabricCompensateResult> {
      return failure('unsupported', 'HEALTH_WEIXIN_COMPENSATION_UNSUPPORTED')
    },
  }
}

function deliveryResult(context: FabricExecutionContext, deliveryId: string, result: WeixinProviderDelivery): FabricExecuteResult {
  const verified = (result.status === 'accepted' || result.status === 'delivered') && validProviderIdentity(result.providerMessageId)
  const output = { schemaVersion: 1, deliveryId, providerMessageId: verified ? result.providerMessageId : null,
    status: verified ? result.status : 'unknown' } as FabricJsonObject
  if (result.status === 'not_sent') return { outcome: 'temporary_failure', output,
    evidence: evidence(context, 'Provider definitively rejected before sending'),
    errorCode: 'HEALTH_WEIXIN_NOT_SENT', safeToRetry: true }
  return !verified
    ? { outcome: 'unknown', output, evidence: evidence(context, 'Delivery status is explicitly uncertain'),
      errorCode: 'HEALTH_WEIXIN_DELIVERY_UNCERTAIN', safeToRetry: false }
    : { outcome: 'succeeded', output, evidence: evidence(context, 'Provider delivery identity captured'),
      errorCode: null, safeToRetry: false }
}

function minimizedMessage(context: FabricExecutionContext): string {
  const actionId = context.capabilityId === 'health.reminder.send' ? context.input.actionId : context.input.checkinId
  if (typeof actionId !== 'string' || actionId.length < 1 || actionId.length > 200) throw new Error('invalid')
  let body: string
  if (context.capabilityId === 'health.reminder.send') {
    if (context.input.schemaVersion !== 2) throw new Error('invalid')
    const code = context.input.messageCode
    if (typeof code !== 'string' || !Object.hasOwn(REMINDER_TEMPLATES, code)) throw new Error('invalid')
    if (context.input.messageText !== undefined) throw new Error('invalid')
    body = REMINDER_TEMPLATES[code]!
  } else {
    if (context.input.schemaVersion !== 1) throw new Error('invalid')
    const operation = context.input.operation
    body = operation === 'request_skin_recapture' ? '请在方便时补充一次标准化皮肤复拍。'
      : operation === 'request_marker_metadata' ? '请在方便时补充缺失的报告信息。' : ''
  }
  if (!body) throw new Error('invalid')
  return `${body}\n操作ID：${actionId}\n完成：hermes://health/actions/${encodeURIComponent(actionId)}/complete`
}

async function executeDelivery(sender: WeixinReceiptSender, context: FabricExecutionContext,
  deliveryId: string, message: string): Promise<FabricExecuteResult> {
  try {
    const persisted = await sender.lookup(deliveryId)
    if (persisted.status !== 'not_found') return deliveryResult(context, deliveryId, persisted)
  } catch { return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE') }
  try {
    return deliveryResult(context, deliveryId,
      await sender.send({ deliveryId, recipient: 'configured-self', message }))
  } catch { return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNCERTAIN') }
}

function validProviderIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !isFabricSensitiveString(value)
}
function stableDeliveryId(context: FabricExecutionContext, identity: { profile: string; accountFingerprint: string }): string {
  const actionId = context.capabilityId === 'health.reminder.send' ? context.input.actionId : context.input.checkinId
  return `health-${createHash('sha256').update(`${identity.profile}:${identity.accountFingerprint}:${context.capabilityId}:${String(actionId)}`).digest('hex').slice(0, 32)}`
}
function executorIdentity(options: HealthWeixinExecutorOptions): { profile: string; accountFingerprint: string } {
  const profile = options.profile.trim()
  if (!profile || profile.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) throw new Error('invalid')
  const identity = options.sender.identity?.()
  if (options.sender.identity && (!identity || identity.profile !== profile || !/^[a-f0-9]{64}$/.test(identity.accountFingerprint))) {
    throw new Error('invalid')
  }
  return identity ?? { profile, accountFingerprint: createHash('sha256').update(`injected:${profile}`).digest('hex') }
}
function evidence(context: FabricExecutionContext, summary: string) { return [{ kind: 'weixin_delivery', summary,
  data: { recipient: 'configured-self' }, capturedAt: context.now ?? new Date().toISOString() }] }
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: evidence(context, outcome), errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
