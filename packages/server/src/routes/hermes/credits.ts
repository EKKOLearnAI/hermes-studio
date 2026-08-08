import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/credits'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const creditRoutes = new Router()

creditRoutes.get('/api/hermes/credits/me', ctrl.me)
creditRoutes.get('/api/hermes/credits/me/ledger', ctrl.myLedger)
creditRoutes.get('/api/hermes/credits/users/:id', requireSuperAdmin, ctrl.userSummary)
creditRoutes.post('/api/hermes/credits/recharge', requireSuperAdmin, ctrl.recharge)
creditRoutes.post('/api/hermes/credits/refund', requireSuperAdmin, ctrl.refund)