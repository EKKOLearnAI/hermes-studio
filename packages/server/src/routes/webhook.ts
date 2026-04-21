import Router from '@koa/router'
import { emitWebhook } from '../services/hermes/hermes'
import { logger } from '../services/logger'

export const webhookRoutes = new Router()

/**
 * POST /webhook — receive callbacks from Hermes Agent
 *
 * Expected body:
 * {
 *   "event": "run.completed" | "job.completed" | ...,
 *   "run_id": "...",
 *   "data": { ... }
 * }
 *
 * TODO: Add signature verification when Hermes supports webhook signing
 */
webhookRoutes.post('/webhook', async (ctx) => {
  const payload = ctx.request.body

  if (!payload || !payload.event) {
    ctx.status = 400
    ctx.body = { error: 'Missing event field' }
    return
  }

  logger.info('Received webhook event: %s', payload.event)

  // Emit to registered callbacks
  emitWebhook(payload)

  ctx.body = { ok: true }
})
