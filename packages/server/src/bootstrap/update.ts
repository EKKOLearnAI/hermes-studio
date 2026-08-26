import { getWebUiHome } from '../config'
import { requireSuperAdmin } from '../middleware/user-auth'
import * as updateController from '../modules/studio/controllers/update'
import { configureSuperAdminMiddleware } from '../modules/studio/middleware/super-admin'
import { updateRoutes } from '../modules/studio/routes/update'
import {
  configureUpdateRuntime,
  stopPreviewRuntime,
} from '../modules/studio/services/update/version-preview-manager'
import { isDockerContainer } from '../services/runtime-environment'

configureUpdateRuntime({ getWebUiHome, isDockerContainer })
configureSuperAdminMiddleware(requireSuperAdmin)

export const {
  handleUpdate,
  installPreview,
  preparePreview,
  previewStatus,
  previewTags,
  startPreview,
  stopPreview,
} = updateController

export { stopPreviewRuntime, updateRoutes }
