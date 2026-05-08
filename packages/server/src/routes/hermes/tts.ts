import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/tts'

export const ttsRoutes = new Router()

ttsRoutes.post('/api/hermes/tts', ctrl.generate)
