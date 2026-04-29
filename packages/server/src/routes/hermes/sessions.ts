import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/sessions'

export const sessionRoutes = new Router()

sessionRoutes.get('/api/hermes/sessions/conversations', ctrl.listConversations)
sessionRoutes.get('/api/hermes/sessions/conversations/:id/messages', ctrl.getConversationMessages)
sessionRoutes.get('/api/hermes/sessions', ctrl.list)
sessionRoutes.get('/api/hermes/search/sessions', ctrl.search)
sessionRoutes.get('/api/hermes/sessions/search', ctrl.search)
sessionRoutes.get('/api/hermes/sessions/usage', ctrl.usageBatch)
sessionRoutes.get('/api/hermes/usage/stats', ctrl.usageStats)
sessionRoutes.get('/api/hermes/sessions/context-length', ctrl.contextLength)
sessionRoutes.get('/api/hermes/sessions/:id', ctrl.get)
sessionRoutes.get('/api/hermes/sessions/:id/usage', ctrl.usageSingle)
sessionRoutes.delete('/api/hermes/sessions/:id', ctrl.remove)
sessionRoutes.post('/api/hermes/sessions/:id/rename', ctrl.rename)
