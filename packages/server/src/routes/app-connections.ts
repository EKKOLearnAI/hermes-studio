import Router from '@koa/router'
import * as ctrl from '../controllers/app-connections'

export const appConnectionRoutes = new Router()

appConnectionRoutes.get('/api/app-connections', ctrl.listAppConnectionsController)
appConnectionRoutes.post('/api/app-connections/authorization-codes/lan', ctrl.createAppAuthorizationCodeController)
appConnectionRoutes.post('/api/app-connections/authorization-codes/cloud', ctrl.createCloudAppAuthorizationCodeController)
appConnectionRoutes.delete('/api/app-connections/:id', ctrl.deleteAppConnectionController)
