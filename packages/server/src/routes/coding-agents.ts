import Router from '@koa/router'
import * as ctrl from '../controllers/coding-agents'

export const codingAgentRoutes = new Router()

codingAgentRoutes.get('/api/coding-agents', ctrl.status)
codingAgentRoutes.post('/api/coding-agents/:id/install', ctrl.install)
codingAgentRoutes.delete('/api/coding-agents/:id', ctrl.remove)
codingAgentRoutes.get('/api/coding-agents/:id/config-files/:key', ctrl.readConfigFile)
codingAgentRoutes.put('/api/coding-agents/:id/config-files/:key', ctrl.writeConfigFile)
