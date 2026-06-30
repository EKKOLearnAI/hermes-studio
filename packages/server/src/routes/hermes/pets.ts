import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/pets'

export const petRoutes = new Router()

petRoutes.get('/api/hermes/pets/active', ctrl.active)
petRoutes.patch('/api/hermes/pets/active', ctrl.updateActive)
petRoutes.post('/api/hermes/pets/adopt', ctrl.adopt)
