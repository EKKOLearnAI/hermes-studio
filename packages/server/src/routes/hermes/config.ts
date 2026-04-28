import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/config'

export const configRoutes = new Router()

configRoutes.get('/api/hermes/config', ctrl.getConfig)
configRoutes.put('/api/hermes/config', ctrl.updateConfig)
configRoutes.put('/api/hermes/config/credentials', ctrl.updateCredentials)
