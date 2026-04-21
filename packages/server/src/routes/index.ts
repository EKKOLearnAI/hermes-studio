import type { Context, Next } from 'koa'

// Shared route modules
import { healthRoutes } from './health'
import { webhookRoutes } from './webhook'
import { uploadRoutes } from './upload'
import { updateRoutes } from './update'

// Hermes route modules
import { sessionRoutes } from './hermes/sessions'
import { profileRoutes } from './hermes/profiles'
import { skillRoutes } from './hermes/skills'
import { memoryRoutes } from './hermes/memory'
import { modelRoutes } from './hermes/models'
import { providerRoutes } from './hermes/providers'
import { configRoutes } from './hermes/config'
import { logRoutes } from './hermes/logs'
import { codexAuthRoutes } from './hermes/codex-auth'
import { gatewayRoutes } from './hermes/gateways'
import { weixinRoutes } from './hermes/weixin'
import { proxyRoutes, proxyMiddleware } from './hermes/proxy'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes. Returns the proxy middleware (must be mounted last).
 */
export function registerRoutes(app: any, requireAuth: (ctx: Context, next: Next) => Promise<void>) {
  // --- Public routes (no auth required) ---
  app.use(healthRoutes.routes())
  app.use(webhookRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  app.use(requireAuth)

  // --- Protected routes (auth required) ---
  app.use(uploadRoutes.routes())
  app.use(updateRoutes.routes())           // Must be before proxy (proxy catch-all matches everything)
  app.use(sessionRoutes.routes())
  app.use(profileRoutes.routes())
  app.use(skillRoutes.routes())
  app.use(memoryRoutes.routes())
  app.use(modelRoutes.routes())
  app.use(providerRoutes.routes())
  app.use(configRoutes.routes())
  app.use(logRoutes.routes())
  app.use(codexAuthRoutes.routes())
  app.use(gatewayRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(proxyRoutes.routes())

  // Proxy catch-all middleware (must be last)
  return proxyMiddleware
}
