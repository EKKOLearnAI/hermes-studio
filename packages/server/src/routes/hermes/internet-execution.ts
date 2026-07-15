import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/internet-execution'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const internetExecutionRoutes = new Router()

internetExecutionRoutes.get('/api/hermes/internet-execution/overview', ctrl.overview)
internetExecutionRoutes.post('/api/hermes/internet-execution/bilibili/search', requireSuperAdmin, ctrl.searchBilibili)
internetExecutionRoutes.post('/api/hermes/internet-execution/bilibili/inspect', requireSuperAdmin, ctrl.inspectBilibili)
internetExecutionRoutes.get('/api/hermes/internet-execution/receipts', ctrl.receipts)
internetExecutionRoutes.get('/api/hermes/internet-execution/receipts/:workflowId', ctrl.receipt)
internetExecutionRoutes.get('/api/hermes/internet-execution/workflows/:workflowId', ctrl.workflow)
