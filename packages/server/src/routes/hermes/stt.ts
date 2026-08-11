import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/stt'
import * as localModelCtrl from '../../controllers/hermes/local-stt-model'

export const sttProtectedRoutes = new Router()

sttProtectedRoutes.get('/api/hermes/stt/settings', ctrl.listSettings)
sttProtectedRoutes.get('/api/hermes/stt/local-model', localModelCtrl.status)
sttProtectedRoutes.post('/api/hermes/stt/local-model/download', localModelCtrl.download)
sttProtectedRoutes.post('/api/hermes/voice/proxy/:profile/v1/audio/transcriptions', ctrl.transcribeVoiceProxy)
sttProtectedRoutes.get('/api/hermes/stt/profile-status', ctrl.profileStatus)
sttProtectedRoutes.get('/api/hermes/stt/profile-status/missing-audio', ctrl.missingProfileAudio)
sttProtectedRoutes.post('/api/hermes/mcu/voice-turn', ctrl.mcuVoiceTurn)
sttProtectedRoutes.put('/api/hermes/stt/settings/active', ctrl.saveActiveProvider)
sttProtectedRoutes.put('/api/hermes/stt/settings/:provider', ctrl.saveSettings)
sttProtectedRoutes.delete('/api/hermes/stt/settings/:provider', ctrl.deleteProvider)
sttProtectedRoutes.delete('/api/hermes/stt/settings/:provider/base-url-preset', ctrl.deleteBaseUrlPreset)
sttProtectedRoutes.delete('/api/hermes/stt/settings/:provider/secret/:secretName', ctrl.deleteSecret)
sttProtectedRoutes.post('/api/hermes/stt/local-stream', ctrl.startLocalStream)
sttProtectedRoutes.post('/api/hermes/stt/local-stream/:sessionId/chunk', ctrl.pushLocalStreamChunk)
sttProtectedRoutes.post('/api/hermes/stt/local-stream/:sessionId/finish', ctrl.finishLocalStream)
sttProtectedRoutes.delete('/api/hermes/stt/local-stream/:sessionId', ctrl.cancelLocalStream)
sttProtectedRoutes.post('/api/hermes/stt/transcribe', ctrl.transcribe)
