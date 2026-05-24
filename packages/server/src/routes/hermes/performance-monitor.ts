import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/performance-monitor'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const performanceMonitorRoutes = new Router()

performanceMonitorRoutes.get('/api/hermes/performance/runtime', requireSuperAdmin, ctrl.runtime)
