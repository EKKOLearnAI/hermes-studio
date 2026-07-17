import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/providers'
import { requireAdmin, requireUserProfile } from '../../middleware/user-auth'

export const providerRoutes = new Router()

providerRoutes.post('/api/hermes/config/providers', ctrl.create)
// Backward-compatible legacy update route. New clients should use the editor
// resource below for field capabilities and revision-checked writes.
providerRoutes.put('/api/hermes/config/providers/:poolKey', ctrl.update)
providerRoutes.delete('/api/hermes/config/providers/:poolKey', ctrl.remove)
providerRoutes.get('/api/hermes/config/providers/:poolKey/editor', requireUserProfile, requireAdmin, ctrl.getEditor)
providerRoutes.patch('/api/hermes/config/providers/:poolKey/editor', requireUserProfile, requireAdmin, ctrl.patchEditor)
providerRoutes.post('/api/hermes/config/providers/:poolKey/editor/test', requireUserProfile, requireAdmin, ctrl.testEditor)
providerRoutes.patch('/api/hermes/config/providers/:poolKey/editor/contexts', requireUserProfile, requireAdmin, ctrl.patchEditorContexts)
