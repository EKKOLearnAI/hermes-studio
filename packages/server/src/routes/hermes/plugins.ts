import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/plugins'

export const pluginRoutes = new Router()

pluginRoutes.get('/api/hermes/plugins', ctrl.list)
