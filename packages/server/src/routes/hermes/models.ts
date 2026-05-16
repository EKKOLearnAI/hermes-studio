import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/models'

export const modelRoutes = new Router()

modelRoutes.get('/api/hermes/available-models', ctrl.getAvailable)
modelRoutes.post('/api/hermes/provider-models', ctrl.fetchProviderModelList)
modelRoutes.get('/api/hermes/config/models', ctrl.getConfigModels)
modelRoutes.put('/api/hermes/config/model', ctrl.setConfigModel)
modelRoutes.put('/api/hermes/model-alias', ctrl.setModelAlias)
modelRoutes.put('/api/hermes/model-visibility', ctrl.setModelVisibility)

// Model context routes
modelRoutes.get('/api/hermes/model-context', ctrl.getModelContext)
modelRoutes.get('/api/hermes/model-context/:provider/:model', ctrl.getModelContext)
modelRoutes.put('/api/hermes/model-context/:provider/:model', ctrl.updateModelContext)
modelRoutes.put('/api/hermes/model-context', ctrl.updateModelContext)
