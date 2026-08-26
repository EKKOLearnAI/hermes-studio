import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/files'
import { previewProfileFile } from '../controllers/file-preview'

export const fileRoutes = new Router()

fileRoutes.get('/api/hermes/files/preview', previewProfileFile)
fileRoutes.get('/api/hermes/files/list', ctrl.list)
fileRoutes.get('/api/hermes/files/stat', ctrl.stat)
fileRoutes.get('/api/hermes/files/read', requireSuperAdmin, ctrl.read)
fileRoutes.put('/api/hermes/files/write', requireSuperAdmin, ctrl.write)
fileRoutes.delete('/api/hermes/files/delete', requireSuperAdmin, ctrl.remove)
fileRoutes.post('/api/hermes/files/rename', requireSuperAdmin, ctrl.rename)
fileRoutes.post('/api/hermes/files/mkdir', requireSuperAdmin, ctrl.mkdir)
fileRoutes.post('/api/hermes/files/copy', requireSuperAdmin, ctrl.copy)
fileRoutes.post('/api/hermes/files/upload', requireSuperAdmin, ctrl.upload)
