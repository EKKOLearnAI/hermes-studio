import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/mcu-firmware'

export const mcuFirmwareRoutes = new Router()

mcuFirmwareRoutes.get('/api/hermes/mcu/firmware/:version/manifest', ctrl.manifest)
mcuFirmwareRoutes.get('/api/hermes/mcu/firmware/:version/firmware.bin', ctrl.download)
mcuFirmwareRoutes.get('/api/hermes/mcu/firmware/manifest', ctrl.legacyManifest)
mcuFirmwareRoutes.get('/api/hermes/mcu/firmware.bin', ctrl.legacyDownload)
