import { createHash } from 'crypto'
import { isFabricSensitiveString } from '../../action-fabric/audit'
import type {
  FabricCompensateResult, FabricExecutionContext, FabricExecutorAdapter, FabricInterruptResult,
  FabricPrepareResult, FabricExecuteResult, FabricVerifyResult,
} from '../../action-fabric/executors'
import type { FabricJsonObject } from '../../action-fabric/types'
import type { WeixinReceiptSender, WeixinProviderDelivery } from '../../weixin-sender'

export interface HealthWeixinExecutorOptions { profile: string; sender: WeixinReceiptSender }

export function createHealthWeixinExecutorAdapter(options: HealthWeixinExecutorOptions): FabricExecutorAdapter {
  const attempts = new Map<string, { deliveryId: string; result: WeixinProviderDelivery }>()
  return {
    id: 'health-weixin', type: 'connector',
    async prepare(context): Promise<FabricPrepareResult> {
      try {
        if (!['health.reminder.send', 'health.checkin.request'].includes(context.capabilityId)
          || context.input.recipient !== 'configured-self' || context.target.recipient !== 'configured-self') throw new Error('invalid')
        const deliveryId = stableDeliveryId(context)
        const message = minimizedMessage(context)
        return success('prepared', context, { deliveryId, messageDigest: createHash('sha256').update(message).digest('hex') })
      } catch { return failure('failed', 'HEALTH_WEIXIN_REQUEST_INVALID') }
    },
    async execute(context): Promise<FabricExecuteResult> {
      let deliveryId: string
      let message: string
      try {
        deliveryId = stableDeliveryId(context); message = minimizedMessage(context)
        if (!context.preparedOutput || context.preparedOutput.deliveryId !== deliveryId
          || context.preparedOutput.messageDigest !== createHash('sha256').update(message).digest('hex')) throw new Error('invalid')
      } catch { return failure('permanent_failure', 'HEALTH_WEIXIN_PREPARATION_INVALID') }
      const prior = attempts.get(context.executionToken)
      if (prior) {
        let queried: WeixinProviderDelivery
        try {
          const lookup = await options.sender.lookup(prior.deliveryId)
          queried = lookup.status === 'not_found' ? prior.result : lookup
        } catch { queried = prior.result }
        attempts.set(context.executionToken, { deliveryId, result: queried })
        return deliveryResult(context, deliveryId, queried)
      }
      try {
        const persisted = await options.sender.lookup(deliveryId)
        if (persisted.status !== 'not_found') {
          attempts.set(context.executionToken, { deliveryId, result: persisted })
          return deliveryResult(context, deliveryId, persisted)
        }
      } catch {
        return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE')
      }
      let result: WeixinProviderDelivery
      try {
        result = await options.sender.send({ deliveryId, recipient: 'configured-self', message })
      } catch { result = { status: 'unknown', providerMessageId: null } }
      attempts.set(context.executionToken, { deliveryId, result })
      return deliveryResult(context, deliveryId, result)
    },
    async verify(context): Promise<FabricVerifyResult> {
      const deliveryId = context.executionOutput?.deliveryId
      if (typeof deliveryId !== 'string') return failure('failed', 'HEALTH_WEIXIN_VERIFICATION_INVALID')
      let status: Awaited<ReturnType<WeixinReceiptSender['lookup']>>
      try { status = await options.sender.lookup(deliveryId) } catch {
        return failure('unknown', 'HEALTH_WEIXIN_DELIVERY_UNVERIFIABLE')
      }
      return status.status === 'accepted' || status.status === 'delivered'
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
  const output = { schemaVersion: 1, deliveryId, providerMessageId: result.providerMessageId,
    status: result.status } as FabricJsonObject
  return result.status === 'unknown'
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
    if (typeof context.input.messageText !== 'string' || isFabricSensitiveString(context.input.messageText)) throw new Error('invalid')
    body = context.input.messageText.replace(/\s+/g, ' ').trim().slice(0, 240)
  } else {
    const operation = context.input.operation
    body = operation === 'request_skin_recapture' ? '请在方便时补充一次标准化皮肤复拍。'
      : operation === 'request_marker_metadata' ? '请在方便时补充缺失的报告信息。' : ''
  }
  if (!body) throw new Error('invalid')
  return `${body}\n操作ID：${actionId}\n完成：hermes://health/actions/${encodeURIComponent(actionId)}/complete`
}
function stableDeliveryId(context: FabricExecutionContext): string {
  const actionId = context.capabilityId === 'health.reminder.send' ? context.input.actionId : context.input.checkinId
  return `health-${createHash('sha256').update(`${context.capabilityId}:${String(actionId)}`).digest('hex').slice(0, 32)}`
}
function evidence(context: FabricExecutionContext, summary: string) { return [{ kind: 'weixin_delivery', summary,
  data: { recipient: 'configured-self' }, capturedAt: context.now ?? new Date().toISOString() }] }
function success<T extends string>(outcome: T, context: FabricExecutionContext, output: FabricJsonObject) {
  return { outcome, output, evidence: evidence(context, outcome), errorCode: null, safeToRetry: false }
}
function failure<T extends string>(outcome: T, errorCode: string) { return { outcome, output: {}, evidence: [], errorCode, safeToRetry: false } }
