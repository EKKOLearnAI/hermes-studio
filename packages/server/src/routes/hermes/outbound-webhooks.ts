import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/outbound-webhooks'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const outboundWebhookRoutes = new Router()

// Capability discovery stays open to any authenticated user: a client needs it
// to know whether to show webhook features at all.
outboundWebhookRoutes.get('/api/hermes/capabilities', ctrl.getCapabilities)

// Managing destinations means handling secrets and choosing where operational
// data leaves the instance, so it is super-admin only.
outboundWebhookRoutes.get('/api/hermes/webhooks/endpoints', requireSuperAdmin, ctrl.listWebhookEndpoints)
outboundWebhookRoutes.post('/api/hermes/webhooks/endpoints', requireSuperAdmin, ctrl.createWebhookEndpoint)
outboundWebhookRoutes.patch('/api/hermes/webhooks/endpoints/:id', requireSuperAdmin, ctrl.updateWebhookEndpoint)
outboundWebhookRoutes.delete('/api/hermes/webhooks/endpoints/:id', requireSuperAdmin, ctrl.removeWebhookEndpoint)
outboundWebhookRoutes.put('/api/hermes/webhooks/endpoints/:id/enabled', requireSuperAdmin, ctrl.setWebhookEndpointEnabled)
outboundWebhookRoutes.post('/api/hermes/webhooks/endpoints/:id/test', requireSuperAdmin, ctrl.testWebhookEndpoint)
outboundWebhookRoutes.get('/api/hermes/webhooks/endpoints/:id/deliveries', requireSuperAdmin, ctrl.listWebhookEndpointDeliveries)
