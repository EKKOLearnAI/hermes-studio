import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/app-upload'

export const appUploadRoutes = new Router()

appUploadRoutes.post('/api/hermes/app-uploads', ctrl.open)
appUploadRoutes.put('/api/hermes/app-uploads/:id/chunks', ctrl.appendChunk)
appUploadRoutes.post('/api/hermes/app-uploads/:id/complete', ctrl.complete)
appUploadRoutes.delete('/api/hermes/app-uploads/:id', ctrl.abort)
