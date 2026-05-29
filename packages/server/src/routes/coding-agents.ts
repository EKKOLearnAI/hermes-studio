import Router from '@koa/router'
import * as ctrl from '../controllers/coding-agents'

export const codingAgentRoutes = new Router()

codingAgentRoutes.get('/api/coding-agents', ctrl.status)
codingAgentRoutes.post('/api/coding-agents/:id/install', ctrl.install)
