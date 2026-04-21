import Router from '@koa/router'
import { sessionRoutes } from './sessions'
import { profileRoutes } from './profiles'
import { configRoutes } from './config'
import { fsRoutes } from './filesystem'
import { logRoutes } from './logs'
import { weixinRoutes } from './weixin'
import { codexAuthRoutes } from './codex-auth'
import { gatewayRoutes } from './gateways'
import { downloadRoutes } from './download'
import { fileRoutes } from './files'
import { proxyRoutes, proxyMiddleware } from './proxy'
import { setupTerminalWebSocket } from './terminal'

export const hermesRoutes = new Router()

hermesRoutes.use(sessionRoutes.routes())
hermesRoutes.use(profileRoutes.routes())
hermesRoutes.use(configRoutes.routes())
hermesRoutes.use(fsRoutes.routes())
hermesRoutes.use(logRoutes.routes())
hermesRoutes.use(weixinRoutes.routes())
hermesRoutes.use(codexAuthRoutes.routes())
hermesRoutes.use(gatewayRoutes.routes())
hermesRoutes.use(downloadRoutes.routes())
hermesRoutes.use(fileRoutes.routes())
hermesRoutes.use(proxyRoutes.routes())

export { setupTerminalWebSocket, proxyMiddleware }
