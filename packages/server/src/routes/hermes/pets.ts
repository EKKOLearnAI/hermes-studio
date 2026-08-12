import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/pets'

export const petRoutes = new Router()

petRoutes.get('/api/hermes/pets/active', ctrl.active)
petRoutes.patch('/api/hermes/pets/active', ctrl.updateActive)
petRoutes.post('/api/hermes/pets/adopt', ctrl.adopt)
petRoutes.get('/api/hermes/pets/local', ctrl.listLocal)
petRoutes.get('/api/hermes/pets/local/:slug/asset', ctrl.localAsset)
petRoutes.get('/api/hermes/pets/local/:slug/preview', ctrl.localPreview)
petRoutes.delete('/api/hermes/pets/local/:slug', ctrl.deleteLocal)
petRoutes.post('/api/hermes/pets/import', ctrl.importPet)
