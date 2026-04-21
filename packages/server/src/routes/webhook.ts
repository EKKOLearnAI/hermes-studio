import Router from '@koa/router'
import * as ctrl from '../controllers/webhook'

export const webhookRoutes = new Router()

webhookRoutes.post('/webhook', ctrl.handleWebhook)
