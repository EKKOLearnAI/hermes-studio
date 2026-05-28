import Router from '@koa/router'
import * as ctrl from '../controllers/update'
import { requireSuperAdmin } from '../middleware/user-auth'

export const updateRoutes = new Router()

updateRoutes.post('/api/hermes/update', ctrl.handleUpdate)
updateRoutes.get('/api/hermes/update/preview', requireSuperAdmin, ctrl.previewStatus)
updateRoutes.get('/api/hermes/update/preview/tags', requireSuperAdmin, ctrl.previewTags)
updateRoutes.post('/api/hermes/update/preview/prepare', requireSuperAdmin, ctrl.preparePreview)
updateRoutes.post('/api/hermes/update/preview/install', requireSuperAdmin, ctrl.installPreview)
updateRoutes.post('/api/hermes/update/preview/start', requireSuperAdmin, ctrl.startPreview)
updateRoutes.post('/api/hermes/update/preview/stop', requireSuperAdmin, ctrl.stopPreview)
