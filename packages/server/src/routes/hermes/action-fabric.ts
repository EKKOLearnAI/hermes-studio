import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/action-fabric'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const actionFabricRoutes = new Router()

actionFabricRoutes.get('/api/hermes/action-fabric/capabilities', ctrl.capabilities)
actionFabricRoutes.get('/api/hermes/action-fabric/executors', ctrl.executors)
actionFabricRoutes.post('/api/hermes/action-fabric/intents', requireSuperAdmin, ctrl.createIntent)
actionFabricRoutes.get('/api/hermes/action-fabric/workflows', ctrl.workflows)
actionFabricRoutes.get('/api/hermes/action-fabric/workflows/:id', ctrl.workflowDetail)
actionFabricRoutes.post('/api/hermes/action-fabric/workflows/:id/approve', requireSuperAdmin, ctrl.approveWorkflow)
actionFabricRoutes.post('/api/hermes/action-fabric/workflows/:id/reject', requireSuperAdmin, ctrl.rejectWorkflow)
actionFabricRoutes.post('/api/hermes/action-fabric/workflows/:id/cancel', requireSuperAdmin, ctrl.cancelWorkflow)
actionFabricRoutes.post('/api/hermes/action-fabric/workflows/:id/retry', requireSuperAdmin, ctrl.retryWorkflow)
actionFabricRoutes.post('/api/hermes/action-fabric/workflows/:id/compensate', requireSuperAdmin, ctrl.compensateWorkflow)
actionFabricRoutes.get('/api/hermes/action-fabric/audit', ctrl.auditEvents)
actionFabricRoutes.get('/api/hermes/action-fabric/audit/verify', ctrl.verifyAudit)
actionFabricRoutes.get('/api/hermes/action-fabric/control', ctrl.control)
actionFabricRoutes.put('/api/hermes/action-fabric/control/emergency-stop', requireSuperAdmin, ctrl.updateEmergencyStop)
