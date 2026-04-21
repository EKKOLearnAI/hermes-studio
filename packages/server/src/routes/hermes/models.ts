import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/models'

export const modelRoutes = new Router()

modelRoutes.get('/api/hermes/available-models', ctrl.getAvailable)
modelRoutes.get('/api/hermes/config/models', ctrl.getConfigModels)
modelRoutes.put('/api/hermes/config/model', ctrl.setConfigModel)
