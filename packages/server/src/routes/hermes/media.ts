import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/media'

export const mediaRoutes = new Router()

mediaRoutes.post('/api/hermes/media/grok-image-to-video', ctrl.grokImageToVideo)
mediaRoutes.post('/api/hermes/media/apikey-image-generate', ctrl.apiKeyImageGenerate)
