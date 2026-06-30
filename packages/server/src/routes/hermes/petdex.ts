import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/petdex'

export const petdexRoutes = new Router()
export const petdexPublicRoutes = new Router()

petdexPublicRoutes.get('/api/hermes/petdex/asset', ctrl.asset)
petdexRoutes.get('/api/hermes/petdex/manifest', ctrl.manifest)
