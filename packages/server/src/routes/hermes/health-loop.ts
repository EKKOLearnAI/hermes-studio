import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/health-loop'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const healthLoopRoutes = new Router()

healthLoopRoutes.get('/api/hermes/health-loop/overview', ctrl.overview)
healthLoopRoutes.get('/api/hermes/health-loop/connectors', ctrl.connectors)
healthLoopRoutes.post('/api/hermes/health-loop/connectors/:id/sync', requireSuperAdmin, ctrl.syncConnector)
healthLoopRoutes.post('/api/hermes/health-loop/artifacts', ctrl.createArtifact)
healthLoopRoutes.post('/api/hermes/health-loop/artifacts/:id/analyze', requireSuperAdmin, ctrl.analyzeArtifact)
healthLoopRoutes.post('/api/hermes/health-loop/consents', requireSuperAdmin, ctrl.createConsent)
healthLoopRoutes.post('/api/hermes/health-loop/consents/:id/revoke', requireSuperAdmin, ctrl.revokeConsent)
healthLoopRoutes.get('/api/hermes/health-loop/interventions', ctrl.interventions)
healthLoopRoutes.post('/api/hermes/health-loop/interventions/:id/feedback', requireSuperAdmin, ctrl.interventionFeedback)
healthLoopRoutes.get('/api/hermes/health-loop/settings', ctrl.settings)
healthLoopRoutes.put('/api/hermes/health-loop/settings', ctrl.updateSettings)
