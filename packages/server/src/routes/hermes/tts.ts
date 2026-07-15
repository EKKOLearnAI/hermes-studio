import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/tts'

export const ttsRoutes = new Router()
export const ttsProtectedRoutes = new Router()

ttsRoutes.post('/api/hermes/tts', ctrl.generate)
ttsRoutes.post('/api/tts/proxy/audio/speech', ctrl.openaiProxy)
ttsRoutes.get('/api/hermes/mcu/audio/:file', ctrl.mcuAudio)

ttsProtectedRoutes.get('/api/hermes/tts/settings', ctrl.listSettings)
ttsProtectedRoutes.put('/api/hermes/tts/settings/active', ctrl.saveActiveProvider)
ttsProtectedRoutes.put('/api/hermes/tts/settings/:provider', ctrl.saveSettings)
ttsProtectedRoutes.delete('/api/hermes/tts/settings/:provider', ctrl.deleteProvider)
ttsProtectedRoutes.delete('/api/hermes/tts/settings/:provider/base-url-preset', ctrl.deleteBaseUrlPreset)
ttsProtectedRoutes.delete('/api/hermes/tts/settings/:provider/secret/:secretName', ctrl.deleteSecret)
ttsProtectedRoutes.post('/api/voice/providers/probe', ctrl.probeProvider)
ttsProtectedRoutes.post('/api/hermes/tts/synthesize', ctrl.synthesize)
