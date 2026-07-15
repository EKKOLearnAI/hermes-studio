import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/home'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const homeRoutes = new Router()

homeRoutes.get('/api/hermes/home/overview', ctrl.overview)
homeRoutes.get('/api/hermes/home/map', ctrl.legacyMap)
homeRoutes.get('/api/hermes/home/layout', ctrl.legacyLayout)
homeRoutes.get('/api/hermes/home/spaces', ctrl.spaces)
homeRoutes.post('/api/hermes/home/spaces', requireSuperAdmin, ctrl.upsertSpace)
homeRoutes.get('/api/hermes/home/inventory', ctrl.inventory)
homeRoutes.put('/api/hermes/home/inventory/:id', requireSuperAdmin, ctrl.upsertInventoryItem)
homeRoutes.post('/api/hermes/home/inventory/:id/adjust', requireSuperAdmin, ctrl.adjustInventory)
homeRoutes.post('/api/hermes/home/imports/legacy', requireSuperAdmin, ctrl.importLegacy)
homeRoutes.get('/api/hermes/home/devices', ctrl.devices)
homeRoutes.get('/api/hermes/home/bindings', ctrl.bindings)
homeRoutes.get('/api/hermes/home/provider', ctrl.providerHealth)
homeRoutes.post('/api/hermes/home/devices/:id/refresh', requireSuperAdmin, ctrl.refreshDevice)
homeRoutes.post('/api/hermes/home/devices/:id/commands', requireSuperAdmin, ctrl.commandDevice)
homeRoutes.post('/api/hermes/home/scenes/:id/activate', requireSuperAdmin, ctrl.activateScene)
homeRoutes.get('/api/hermes/home/workflows/:id', ctrl.workflow)
homeRoutes.post('/api/hermes/home/workflows/:id/review', requireSuperAdmin, ctrl.reviewWorkflow)
