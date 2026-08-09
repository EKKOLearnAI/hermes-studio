import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/chat-webhooks'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const chatWebhookRoutes = new Router()
export const chatWebhookPublicRoutes = new Router()

chatWebhookPublicRoutes.post('/webhook-test/:token', ctrl.receiveLocalTestWebhook)

chatWebhookRoutes.get('/api/hermes/webhooks/endpoints', requireSuperAdmin, ctrl.listEndpoints)
chatWebhookRoutes.get('/api/hermes/webhooks/local-test-target', requireSuperAdmin, ctrl.localTestTarget)
chatWebhookRoutes.get('/api/hermes/webhooks/local-test-events', requireSuperAdmin, ctrl.localTestEvents)
chatWebhookRoutes.delete('/api/hermes/webhooks/local-test-events', requireSuperAdmin, ctrl.clearLocalTestEvents)
chatWebhookRoutes.post('/api/hermes/webhooks/endpoints', requireSuperAdmin, ctrl.createEndpoint)
chatWebhookRoutes.patch('/api/hermes/webhooks/endpoints/:id', requireSuperAdmin, ctrl.updateEndpoint)
chatWebhookRoutes.delete('/api/hermes/webhooks/endpoints/:id', requireSuperAdmin, ctrl.removeEndpoint)
chatWebhookRoutes.post('/api/hermes/webhooks/endpoints/:id/test', requireSuperAdmin, ctrl.testEndpoint)
