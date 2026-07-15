import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/workflows'

export const workflowRoutes = new Router()

workflowRoutes.get('/api/hermes/workflows', ctrl.list)
workflowRoutes.post('/api/hermes/workflows', ctrl.create)
workflowRoutes.post('/api/hermes/workflows/batch-delete', ctrl.batchRemove)
workflowRoutes.post('/api/hermes/workflows/import/preview', ctrl.previewImport)
workflowRoutes.post('/api/hermes/workflows/import/confirm', ctrl.confirmImport)
workflowRoutes.post('/api/hermes/workflows/import/cancel', ctrl.cancelImport)
workflowRoutes.get('/api/hermes/workflows/:id/export', ctrl.exportDefinition)
workflowRoutes.get('/api/hermes/workflows/:id/runs', ctrl.listRuns)
workflowRoutes.get('/api/hermes/workflows/:id/runs/:runId', ctrl.getRun)
workflowRoutes.post('/api/hermes/workflows/:id/runs/:runId/stop', ctrl.stopRun)
workflowRoutes.post('/api/hermes/workflows/:id/runs/:runId/nodes/:nodeId/approval', ctrl.approveNode)
workflowRoutes.post('/api/hermes/workflows/:id/runs/:runId/rerun-from-node', ctrl.rerunFromNode)
workflowRoutes.delete('/api/hermes/workflows/:id/runs/:runId', ctrl.deleteRun)
workflowRoutes.post('/api/hermes/workflows/:id/run', ctrl.runNow)
workflowRoutes.get('/api/hermes/workflows/:id', ctrl.get)
workflowRoutes.patch('/api/hermes/workflows/:id', ctrl.update)
workflowRoutes.delete('/api/hermes/workflows/:id', ctrl.remove)
