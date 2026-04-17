import Router from '@koa/router'
import { sessionRoutes } from './sessions'
import { profileRoutes } from './profiles'
import { configRoutes } from './config'
import { fsRoutes } from './filesystem'
import { logRoutes } from './logs'
import { weixinRoutes } from './weixin'
import { proxyRoutes, proxyMiddleware } from './proxy'
import { setupTerminalWebSocket } from './terminal'
import { multiProfileJobsRoutes } from './multi-profile-jobs'

export const hermesRoutes = new Router()

hermesRoutes.use(sessionRoutes.routes())
hermesRoutes.use(profileRoutes.routes())
hermesRoutes.use(configRoutes.routes())
hermesRoutes.use(fsRoutes.routes())
hermesRoutes.use(logRoutes.routes())
hermesRoutes.use(weixinRoutes.routes())
hermesRoutes.use(multiProfileJobsRoutes.routes())
hermesRoutes.use(proxyRoutes.routes())

export { setupTerminalWebSocket, proxyMiddleware }
