import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/notifications'

export const notificationRoutes = new Router()

notificationRoutes.get('/api/hermes/notifications', ctrl.list)
notificationRoutes.post('/api/hermes/notifications', ctrl.create)
notificationRoutes.post('/api/hermes/notifications/read-by-key', ctrl.markReadByDedupeKey)
notificationRoutes.post('/api/hermes/notifications/read-all', ctrl.markAllRead)
notificationRoutes.post('/api/hermes/notifications/:id/read', ctrl.markRead)
notificationRoutes.delete('/api/hermes/notifications/:id', ctrl.remove)
