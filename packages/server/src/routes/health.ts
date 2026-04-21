import Router from '@koa/router'
import * as ctrl from '../controllers/health'

export const healthRoutes = new Router()

healthRoutes.get('/health', ctrl.healthCheck)

export { startVersionCheck } from '../controllers/health'
