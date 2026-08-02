import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/managed-mcp-capability'

export const managedMcpCapabilityRoutes = new Router()
managedMcpCapabilityRoutes.post('/api/internal/managed-mcp/capabilities/authorize', ctrl.authorize)
