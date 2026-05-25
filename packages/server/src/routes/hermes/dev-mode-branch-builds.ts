import Router from '@koa/router'
import { requireSuperAdmin } from '../../middleware/user-auth'
import * as ctrl from '../../controllers/hermes/dev-mode-branch-builds'

export const devModeBranchBuildRoutes = new Router()

devModeBranchBuildRoutes.get('/api/hermes/dev/branch-builds/capabilities', requireSuperAdmin, ctrl.getCapabilities)
devModeBranchBuildRoutes.get('/api/hermes/dev/branch-builds/branches', requireSuperAdmin, ctrl.listBranches)
devModeBranchBuildRoutes.get('/api/hermes/dev/branch-builds/status', requireSuperAdmin, ctrl.getStatus)
devModeBranchBuildRoutes.post('/api/hermes/dev/branch-builds/build', requireSuperAdmin, ctrl.buildBranch)
devModeBranchBuildRoutes.post('/api/hermes/dev/branch-builds/reset', requireSuperAdmin, ctrl.resetBranchPreview)
