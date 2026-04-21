import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/sessions'

export const sessionRoutes = new Router()

sessionRoutes.get('/api/hermes/sessions/conversations', ctrl.listConversations)
sessionRoutes.get('/api/hermes/sessions/conversations/:id/messages', ctrl.getConversationMessages)
sessionRoutes.get('/api/hermes/sessions', ctrl.list)
sessionRoutes.get('/api/hermes/sessions/:id', ctrl.get)
sessionRoutes.delete('/api/hermes/sessions/:id', ctrl.remove)
sessionRoutes.post('/api/hermes/sessions/:id/rename', ctrl.rename)
