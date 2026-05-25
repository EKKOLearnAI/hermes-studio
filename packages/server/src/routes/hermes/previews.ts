import Router from '@koa/router'
import { requireSuperAdmin } from '../../middleware/user-auth'
import * as ctrl from '../../controllers/hermes/previews'

export const previewRoutes = new Router()

previewRoutes.get('/api/hermes/previews', requireSuperAdmin, ctrl.listPreviews)
previewRoutes.get('/api/hermes/previews/:previewId', requireSuperAdmin, ctrl.getPreview)
previewRoutes.post('/api/hermes/previews', requireSuperAdmin, ctrl.startPreview)
previewRoutes.post('/api/hermes/previews/:previewId/stop', requireSuperAdmin, ctrl.stopPreview)
