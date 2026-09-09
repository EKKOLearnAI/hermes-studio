import { requireAdmin } from '../../studio/public/auth'
import Router from '@koa/router'
import * as ctrl from '../controllers/agents'

export const codingAgentRoutes = new Router()

codingAgentRoutes.get('/api/coding-agents/update-policies', requireAdmin, ctrl.updatePolicies)
codingAgentRoutes.put('/api/coding-agents/:id/update-policy', requireAdmin, ctrl.setUpdatePolicy)
codingAgentRoutes.get('/api/coding-agents', ctrl.status)
codingAgentRoutes.post('/api/coding-agents/:id/install', ctrl.install)
codingAgentRoutes.post('/api/coding-agents/:id/check-update', ctrl.checkUpdate)
codingAgentRoutes.post('/api/coding-agents/:id/launch/prepare', ctrl.prepareLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/launch/native', ctrl.nativeLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/runs', ctrl.startRun)
codingAgentRoutes.post('/api/coding-agents/runs/:sessionId/input', ctrl.sendRunInput)
codingAgentRoutes.delete('/api/coding-agents/runs/:sessionId', ctrl.stopRun)
codingAgentRoutes.delete('/api/coding-agents/:id', ctrl.remove)
codingAgentRoutes.get('/api/coding-agents/:id/config-files/:key', ctrl.readConfigFile)
codingAgentRoutes.put('/api/coding-agents/:id/config-files/:key', ctrl.writeConfigFile)
codingAgentRoutes.get('/api/coding-agents/:id/mcp/servers', ctrl.listMcpServers)
codingAgentRoutes.post('/api/coding-agents/:id/mcp/servers', ctrl.addMcpServer)
codingAgentRoutes.patch('/api/coding-agents/:id/mcp/servers/:name', ctrl.updateMcpServer)
codingAgentRoutes.delete('/api/coding-agents/:id/mcp/servers/:name', ctrl.removeMcpServer)
codingAgentRoutes.post('/api/coding-agents/:id/mcp/servers/:name/test', ctrl.testMcpServer)
