import { logger } from '../services/logger'

export async function handleWebhook(ctx: any) {
  const payload = ctx.request.body
  if (!payload || !payload.event) {
    ctx.status = 400
    ctx.body = { error: 'Missing event field' }
    return
  }
  logger.info('Received webhook event: %s', payload.event)
  ctx.body = { ok: true }
}
