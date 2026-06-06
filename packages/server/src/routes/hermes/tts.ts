import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/tts'

export const ttsRoutes = new Router()
export const ttsProtectedRoutes = new Router()

ttsRoutes.post('/api/hermes/tts', ctrl.generate)
ttsRoutes.post('/api/tts/proxy/audio/speech', ctrl.openaiProxy)

ttsProtectedRoutes.post('/api/hermes/tts/synthesize', ctrl.synthesize)
