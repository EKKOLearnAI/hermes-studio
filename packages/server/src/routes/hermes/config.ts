import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/config'

export const configRoutes = new Router()

configRoutes.get('/api/hermes/config', ctrl.getConfig)
configRoutes.put('/api/hermes/config', ctrl.updateConfig)
configRoutes.get('/api/hermes/config/auxiliary-models', ctrl.getAuxiliaryModels)
configRoutes.put('/api/hermes/config/auxiliary-models', ctrl.updateAuxiliaryModels)
configRoutes.get('/api/hermes/config/moa', ctrl.getMoaConfig)
configRoutes.put('/api/hermes/config/moa', ctrl.updateMoaConfig)
configRoutes.put('/api/hermes/config/credentials', ctrl.updateCredentials)
