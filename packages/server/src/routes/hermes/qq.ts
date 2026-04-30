import { Router } from '@koa/router'
import { getQrcode, pollStatus, save } from '../../controllers/hermes/qq'

export const qqRoutes = new Router({ prefix: '/api/hermes/qq' })

qqRoutes.get('/qrcode', getQrcode)
qqRoutes.get('/qrcode/status', pollStatus)
qqRoutes.post('/save', save)
