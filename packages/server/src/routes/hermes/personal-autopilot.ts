import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/personal-autopilot'

export const personalAutopilotRoutes = new Router()

personalAutopilotRoutes.get('/api/hermes/personal-autopilot/overview', ctrl.overview)
