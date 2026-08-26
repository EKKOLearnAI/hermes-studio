import Router from '@koa/router'
import * as ctrl from '../controllers/logs'

export const logRoutes = new Router()

logRoutes.get('/api/hermes/logs', ctrl.list)
logRoutes.get('/api/hermes/logs/:name', ctrl.read)
