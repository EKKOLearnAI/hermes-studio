import Router from '@koa/router'
import * as ctrl from '../controllers/chat-run'
export { getChatRunServer, setChatRunServer } from '../public/chat-run'

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/chat-run/runs', ctrl.runOnce)
