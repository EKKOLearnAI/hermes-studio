import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/stt'

export const sttProtectedRoutes = new Router()

sttProtectedRoutes.get('/api/hermes/stt/settings', ctrl.listSettings)
sttProtectedRoutes.get('/api/hermes/stt/profile-status', ctrl.profileStatus)
sttProtectedRoutes.get('/api/hermes/stt/profile-status/missing-audio', ctrl.missingProfileAudio)
sttProtectedRoutes.post('/api/hermes/mcu/voice-turn', ctrl.mcuVoiceTurn)
sttProtectedRoutes.put('/api/hermes/stt/settings/active', ctrl.saveActiveProvider)
sttProtectedRoutes.put('/api/hermes/stt/settings/:provider', ctrl.saveSettings)
sttProtectedRoutes.delete('/api/hermes/stt/settings/:provider/base-url-preset', ctrl.deleteBaseUrlPreset)
sttProtectedRoutes.delete('/api/hermes/stt/settings/:provider/secret/:secretName', ctrl.deleteSecret)
sttProtectedRoutes.post('/api/hermes/stt/transcribe', ctrl.transcribe)
