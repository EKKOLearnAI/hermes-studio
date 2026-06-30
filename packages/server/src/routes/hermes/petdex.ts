import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/petdex'

export const petdexRoutes = new Router()

petdexRoutes.get('/api/hermes/petdex/manifest', ctrl.manifest)
