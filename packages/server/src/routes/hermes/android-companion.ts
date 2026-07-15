import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/android-companion'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const androidCompanionRoutes = new Router()

androidCompanionRoutes.get('/api/hermes/android-companion/overview', ctrl.overview)
androidCompanionRoutes.post('/api/hermes/android-companion/pairing/offers', requireSuperAdmin, ctrl.issuePairingOffer)
androidCompanionRoutes.delete('/api/hermes/android-companion/pairing/offers/:challengeId', requireSuperAdmin, ctrl.revokePairingOffer)
androidCompanionRoutes.post('/api/hermes/android-companion/pairing/complete', requireSuperAdmin, ctrl.completePairing)
androidCompanionRoutes.get('/api/hermes/android-companion/devices', ctrl.devices)
androidCompanionRoutes.post('/api/hermes/android-companion/devices/:deviceId/revoke', requireSuperAdmin, ctrl.revokeDevice)
androidCompanionRoutes.get('/api/hermes/android-companion/capabilities', ctrl.capabilities)
androidCompanionRoutes.get('/api/hermes/android-companion/commands', ctrl.commands)
androidCompanionRoutes.get('/api/hermes/android-companion/receipts', ctrl.receipts)
androidCompanionRoutes.get('/api/hermes/android-companion/notifications', ctrl.notifications)
androidCompanionRoutes.get('/api/hermes/android-companion/artifacts', ctrl.artifacts)
androidCompanionRoutes.get('/api/hermes/android-companion/takeovers', ctrl.takeovers)
