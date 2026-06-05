import Router from '@koa/router'
import * as ctrl from '../controllers/devices'

export const devicePublicRoutes = new Router()
export const deviceRoutes = new Router()

devicePublicRoutes.post('/api/devices/link-request', ctrl.requestDeviceLinkController)
devicePublicRoutes.post('/api/devices/link-status', ctrl.requestDeviceLinkStatusController)

deviceRoutes.get('/api/devices', ctrl.listDevices)
deviceRoutes.post('/api/devices/scan', ctrl.scanDevices)
deviceRoutes.post('/api/devices/:id/request', ctrl.requestDevicePairing)
deviceRoutes.post('/api/devices/:id/approve', ctrl.approveDevice)
deviceRoutes.post('/api/devices/:id/reject', ctrl.rejectDevice)
deviceRoutes.post('/api/devices/:id/block', ctrl.blockDevice)
deviceRoutes.post('/api/devices/:id/unblock', ctrl.unblockDevice)
