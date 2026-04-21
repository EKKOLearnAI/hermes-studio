import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/profiles'

export const profileRoutes = new Router()

profileRoutes.get('/api/hermes/profiles', ctrl.list)
profileRoutes.post('/api/hermes/profiles', ctrl.create)
profileRoutes.get('/api/hermes/profiles/:name', ctrl.get)
profileRoutes.delete('/api/hermes/profiles/:name', ctrl.remove)
profileRoutes.post('/api/hermes/profiles/:name/rename', ctrl.rename)
profileRoutes.put('/api/hermes/profiles/active', ctrl.switchProfile)
profileRoutes.post('/api/hermes/profiles/:name/export', ctrl.exportProfile)
profileRoutes.post('/api/hermes/profiles/import', ctrl.importProfile)
