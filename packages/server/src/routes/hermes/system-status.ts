import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/system-status'

export const systemStatusRoutes = new Router()

systemStatusRoutes.get('/api/hermes/system-status', ctrl.getSystemStatus)
systemStatusRoutes.get('/api/hermes/llm-runtime/status', ctrl.getLlmRuntimeStatus)
systemStatusRoutes.post('/api/hermes/system-status/action', ctrl.runSystemStatusAction)
