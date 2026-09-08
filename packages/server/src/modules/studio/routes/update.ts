import Router from '@koa/router'
import * as ctrl from '../controllers/update'
import { requireSuperAdmin } from '../middleware/super-admin'

export const updateRoutes = new Router()

updateRoutes.post('/api/studio/update', ctrl.handleUpdate)
updateRoutes.get('/api/studio/update/preview', requireSuperAdmin, ctrl.previewStatus)
updateRoutes.get('/api/studio/update/preview/tags', requireSuperAdmin, ctrl.previewTags)
updateRoutes.post('/api/studio/update/preview/prepare', requireSuperAdmin, ctrl.preparePreview)
updateRoutes.post('/api/studio/update/preview/install', requireSuperAdmin, ctrl.installPreview)
updateRoutes.post('/api/studio/update/preview/start', requireSuperAdmin, ctrl.startPreview)
updateRoutes.post('/api/studio/update/preview/stop', requireSuperAdmin, ctrl.stopPreview)
