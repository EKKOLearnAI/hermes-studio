import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/mcu-firmware'

export const mcuFirmwareRoutes = new Router()

mcuFirmwareRoutes.get('/api/hermes/mcu/firmware/manifest', ctrl.manifest)
mcuFirmwareRoutes.get('/api/hermes/mcu/firmware.bin', ctrl.download)
