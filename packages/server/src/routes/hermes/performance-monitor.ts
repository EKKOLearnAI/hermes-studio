import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/performance-monitor'

export const performanceMonitorRoutes = new Router()

performanceMonitorRoutes.get('/api/hermes/performance/runtime', ctrl.runtime)
