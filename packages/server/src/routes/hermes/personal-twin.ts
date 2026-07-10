import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/personal-twin'

export const personalTwinRoutes = new Router()

personalTwinRoutes.get('/api/hermes/personal-twin/overview', ctrl.overview)
personalTwinRoutes.get('/api/hermes/personal-twin/entities', ctrl.entities)
personalTwinRoutes.get('/api/hermes/personal-twin/observations', ctrl.observations)
personalTwinRoutes.get('/api/hermes/personal-twin/events', ctrl.events)
personalTwinRoutes.get('/api/hermes/personal-twin/context', ctrl.context)
personalTwinRoutes.post('/api/hermes/personal-twin/imports/legacy', ctrl.importLegacy)
