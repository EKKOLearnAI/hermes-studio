import Router from '@koa/router'
import * as ctrl from '../controllers/upload'

export const uploadRoutes = new Router()

uploadRoutes.post('/upload', ctrl.handleUpload)
