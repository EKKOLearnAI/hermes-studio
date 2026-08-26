import Router from '@koa/router'
import { download } from '../controllers/download'

export const downloadRoutes = new Router()

downloadRoutes.get('/api/hermes/download', download)
