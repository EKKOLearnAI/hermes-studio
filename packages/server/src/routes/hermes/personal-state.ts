import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/personal-state'

export const personalStateRoutes = new Router()

personalStateRoutes.get('/api/hermes/personal-state/overview', ctrl.overview)
personalStateRoutes.post('/api/hermes/personal-state/proposals/:id/approve', ctrl.approve)
personalStateRoutes.post('/api/hermes/personal-state/proposals/:id/reject', ctrl.reject)
personalStateRoutes.post('/api/hermes/personal-state/tasks/:id/check-in', ctrl.checkInTask)
