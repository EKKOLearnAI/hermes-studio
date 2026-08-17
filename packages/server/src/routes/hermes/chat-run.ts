import Router from '@koa/router'
import * as ctrl from '../../controllers/chat-run'
export { getChatRunServer, setChatRunServer } from '../../services/hermes/run-chat/server-registry'

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/chat-run/runs', ctrl.runOnce)
