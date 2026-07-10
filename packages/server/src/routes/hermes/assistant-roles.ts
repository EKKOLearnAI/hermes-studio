import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/assistant-roles'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const assistantRoleRoutes = new Router()

assistantRoleRoutes.get('/api/hermes/assistant-roles', ctrl.list)
assistantRoleRoutes.post('/api/hermes/assistant-roles', requireSuperAdmin, ctrl.create)
assistantRoleRoutes.get('/api/hermes/assistant-roles/:id', ctrl.detail)
assistantRoleRoutes.put('/api/hermes/assistant-roles/:id', requireSuperAdmin, ctrl.update)
assistantRoleRoutes.delete('/api/hermes/assistant-roles/:id', requireSuperAdmin, ctrl.remove)
assistantRoleRoutes.post('/api/hermes/assistant-roles/:id/clone', requireSuperAdmin, ctrl.clone)
assistantRoleRoutes.put('/api/hermes/assistant-roles/:id/profile-mapping', requireSuperAdmin, ctrl.updateProfileMapping)
assistantRoleRoutes.post('/api/hermes/assistant-roles/:id/context/preview', ctrl.previewContext)
