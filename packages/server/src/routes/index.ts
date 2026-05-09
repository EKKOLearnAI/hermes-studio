import type { Context, Next } from 'koa'

// Shared route modules
import { healthRoutes } from './health'
import { webhookRoutes } from './webhook'
import { uploadRoutes } from './upload'
import { updateRoutes } from './update'
import { authPublicRoutes, authProtectedRoutes } from './auth'

// Hermes route modules
import { sessionRoutes } from './hermes/sessions'
import { profileRoutes } from './hermes/profiles'
import { skillRoutes } from './hermes/skills'
import { pluginRoutes } from './hermes/plugins'
import { memoryRoutes } from './hermes/memory'
import { modelRoutes } from './hermes/models'
import { providerRoutes } from './hermes/providers'
import { configRoutes } from './hermes/config'
import { logRoutes } from './hermes/logs'
import { codexAuthRoutes } from './hermes/codex-auth'
import { nousAuthRoutes } from './hermes/nous-auth'
import { copilotAuthRoutes } from './hermes/copilot-auth'
import { gatewayRoutes } from './hermes/gateways'
import { weixinRoutes } from './hermes/weixin'
import { fileRoutes } from './hermes/files'
import { downloadRoutes } from './hermes/download'
import { jobRoutes } from './hermes/jobs'
import { cronHistoryRoutes } from './hermes/cron-history'
import { kanbanRoutes } from './hermes/kanban'
import { ttsRoutes } from './hermes/tts'
import { proxyRoutes, proxyMiddleware } from './hermes/proxy'
import { groupChatRoutes, setGroupChatServer } from './hermes/group-chat'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes. Returns the proxy middleware (must be mounted last).
 */
export function registerRoutes(app: any, requireAuth: (ctx: Context, next: Next) => Promise<void>) {
  // --- Public routes (no auth required) ---
  app.use(healthRoutes.routes())
  app.use(webhookRoutes.routes())
  app.use(authPublicRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  app.use(requireAuth)

  // --- Protected routes (auth required) ---
  app.use(authProtectedRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(updateRoutes.routes())           // Must be before proxy (proxy catch-all matches everything)
  app.use(sessionRoutes.routes())
  app.use(profileRoutes.routes())
  app.use(skillRoutes.routes())
  app.use(pluginRoutes.routes())
  app.use(memoryRoutes.routes())
  app.use(modelRoutes.routes())
  app.use(providerRoutes.routes())
  app.use(configRoutes.routes())
  app.use(logRoutes.routes())
  app.use(codexAuthRoutes.routes())
  app.use(nousAuthRoutes.routes())
  app.use(copilotAuthRoutes.routes())
  app.use(gatewayRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(groupChatRoutes.routes())       // Must be before proxy
  app.use(fileRoutes.routes())              // Must be before proxy (proxy catch-all matches everything)
  app.use(downloadRoutes.routes())          // Must be before proxy
  app.use(jobRoutes.routes())               // Must be before proxy
  app.use(cronHistoryRoutes.routes())        // Must be before proxy
  app.use(kanbanRoutes.routes())             // Must be before proxy
  app.use(ttsRoutes.routes())                // Must be before proxy
  app.use(proxyRoutes.routes())

  // Proxy catch-all middleware (must be last)
  return proxyMiddleware
}
