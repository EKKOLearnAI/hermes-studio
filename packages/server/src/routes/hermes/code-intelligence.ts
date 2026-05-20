import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/code-intelligence'

export const codeIntelligenceRoutes = new Router()

codeIntelligenceRoutes.get('/api/hermes/code-intelligence/summary', ctrl.summary)
