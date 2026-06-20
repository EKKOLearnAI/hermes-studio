import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/gemini-auth'

export const geminiAuthRoutes = new Router()

geminiAuthRoutes.post('/api/hermes/auth/gemini/start', ctrl.start)
geminiAuthRoutes.get('/api/hermes/auth/gemini/poll/:sessionId', ctrl.poll)
geminiAuthRoutes.get('/api/hermes/auth/gemini/status', ctrl.status)
