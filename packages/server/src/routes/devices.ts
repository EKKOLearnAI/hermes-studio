import Router from '@koa/router'
import * as ctrl from '../controllers/devices'

export const deviceRoutes = new Router()

deviceRoutes.get('/api/devices', ctrl.listDevices)
deviceRoutes.post('/api/devices/scan', ctrl.scanDevices)
