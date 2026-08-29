import Router from '@koa/router'
import * as ctrl from '../controllers/chat-run'
export { getChatRunServer, setChatRunServer } from '../public/chat-run'

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/studio/chat-run/runs', ctrl.runOnce)
