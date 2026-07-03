import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/journey'

export const journeyRoutes = new Router()

journeyRoutes.get('/api/hermes/journey', ctrl.graph)
