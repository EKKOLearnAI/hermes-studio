import Router from '@koa/router'
import { codexProxyModels, codexProxyResponses } from '../services/codex-proxy'

export const codexProxyRoutes = new Router()

codexProxyRoutes.get('/api/codex-proxy/:key/v1/models', codexProxyModels)
codexProxyRoutes.post('/api/codex-proxy/:key/v1/responses', codexProxyResponses)
