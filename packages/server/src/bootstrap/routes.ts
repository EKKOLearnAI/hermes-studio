import type { Context, Next } from 'koa'
import { apiDocsRoutes } from '../modules/studio'
import { healthRoutes } from './health'
import { updateRoutes } from './update'

// Shared legacy route modules. Move these imports into their owning module as
// each vertical slice is migrated.
import { uploadRoutes } from '../routes/upload'
import { appUploadRoutes } from '../routes/hermes/app-upload'
import { authPublicRoutes, authProtectedRoutes } from '../routes/auth'
import { devicePublicRoutes, deviceRoutes } from '../routes/devices'
import { mcuDeviceRoutes } from '../routes/mcu-devices'
import { codingAgentRoutes } from '../routes/coding-agents'
import { appRelayRoutes } from '../routes/app-relay'
import { appConnectionRoutes } from '../routes/app-connections'
import { socialMessageRoutes } from '../routes/social-messages'
import { themeRoutes } from '../routes/theme'
import { claudeCodeProxyRoutes } from '../routes/claude-code-proxy'
import { codexProxyRoutes } from '../routes/codex-proxy'

// Legacy routes currently stored under routes/hermes. Their final ownership
// may be Studio, Hermes, or another module as documented by the migration map.
import { sessionRoutes } from '../routes/hermes/sessions'
import { profileRoutes } from '../routes/hermes/profiles'
import { skillRoutes } from '../routes/hermes/skills'
import { skillBundleRoutes } from '../routes/hermes/skill-bundles'
import { pluginRoutes } from '../routes/hermes/plugins'
import { memoryRoutes } from '../routes/hermes/memory'
import { modelRoutes } from '../routes/hermes/models'
import { providerRoutes } from '../routes/hermes/providers'
import { configRoutes } from '../routes/hermes/config'
import { logRoutes } from '../routes/hermes/logs'
import { codexAuthRoutes } from '../routes/hermes/codex-auth'
import { nousAuthRoutes } from '../routes/hermes/nous-auth'
import { copilotAuthRoutes } from '../routes/hermes/copilot-auth'
import { xaiAuthRoutes } from '../routes/hermes/xai-auth'
import { anthropicAuthRoutes } from '../routes/hermes/anthropic-auth'
import { minimaxAuthRoutes } from '../routes/hermes/minimax-auth'
import { weixinRoutes } from '../routes/hermes/weixin'
import { fileRoutes } from '../routes/hermes/files'
import { downloadRoutes } from '../routes/hermes/download'
import { jobRoutes } from '../routes/hermes/jobs'
import { cronHistoryRoutes } from '../routes/hermes/cron-history'
import { kanbanRoutes } from '../routes/hermes/kanban'
import { workflowRoutes } from '../routes/hermes/workflows'
import { ttsRoutes, ttsProtectedRoutes } from '../routes/hermes/tts'
import { sttProtectedRoutes } from '../routes/hermes/stt'
import { mcuFirmwareRoutes } from '../routes/hermes/mcu-firmware'
import { mediaRoutes } from '../routes/hermes/media'
import { groupChatPublicRoutes, groupChatRoutes } from '../routes/hermes/group-chat'
import { chatRunRoutes } from '../routes/hermes/chat-run'
import { chatWebhookPublicRoutes, chatWebhookRoutes } from '../routes/hermes/chat-webhooks'
import { performanceMonitorRoutes } from '../routes/hermes/performance-monitor'
import { journeyRoutes } from '../routes/hermes/journey'
import { mcpRoutes } from '../routes/hermes/mcp'
import { runtimeVersionRoutes } from '../routes/hermes/runtime-versions'
import { writeGateRoutes } from '../routes/hermes/write-gate'
import { petdexPublicRoutes, petdexRoutes } from '../routes/hermes/petdex'
import { petRoutes } from '../routes/hermes/pets'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes.
 */
export function registerRoutes(app: any, authMiddleware: Array<(ctx: Context, next: Next) => Promise<void>>) {
  // --- Public routes (no auth required) ---
  app.use(healthRoutes.routes())
  app.use(authPublicRoutes.routes())
  app.use(devicePublicRoutes.routes())
  app.use(claudeCodeProxyRoutes.routes())
  app.use(codexProxyRoutes.routes())
  app.use(ttsRoutes.routes())
  app.use(apiDocsRoutes.routes())
  app.use(petdexPublicRoutes.routes())
  app.use(groupChatPublicRoutes.routes())
  app.use(chatWebhookPublicRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  authMiddleware.forEach((middleware) => app.use(middleware))

  // --- Protected routes (auth required) ---
  app.use(authProtectedRoutes.routes())
  app.use(deviceRoutes.routes())
  app.use(mcuDeviceRoutes.routes())
  app.use(appConnectionRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(appUploadRoutes.routes())
  app.use(updateRoutes.routes())           // Must be before proxy (proxy catch-all matches everything)
  app.use(codingAgentRoutes.routes())
  app.use(themeRoutes.routes())
  app.use(appRelayRoutes.routes())
  app.use(socialMessageRoutes.routes())
  app.use(sessionRoutes.routes())
  app.use(profileRoutes.routes())
  app.use(skillRoutes.routes())
  app.use(skillBundleRoutes.routes())
  app.use(pluginRoutes.routes())
  app.use(memoryRoutes.routes())
  app.use(modelRoutes.routes())
  app.use(providerRoutes.routes())
  app.use(configRoutes.routes())
  app.use(logRoutes.routes())
  app.use(codexAuthRoutes.routes())
  app.use(nousAuthRoutes.routes())
  app.use(copilotAuthRoutes.routes())
  app.use(xaiAuthRoutes.routes())
  app.use(anthropicAuthRoutes.routes())
  app.use(minimaxAuthRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(chatRunRoutes.routes())
  app.use(chatWebhookRoutes.routes())
  app.use(groupChatRoutes.routes())
  app.use(fileRoutes.routes())
  app.use(downloadRoutes.routes())
  app.use(jobRoutes.routes())
  app.use(cronHistoryRoutes.routes())
  app.use(kanbanRoutes.routes())
  app.use(workflowRoutes.routes())
  app.use(ttsProtectedRoutes.routes())
  app.use(sttProtectedRoutes.routes())
  app.use(mcuFirmwareRoutes.routes())
  app.use(mediaRoutes.routes())
  app.use(performanceMonitorRoutes.routes())
  app.use(journeyRoutes.routes())
  app.use(mcpRoutes.routes())                   // MCP management
  app.use(runtimeVersionRoutes.routes())         // Runtime and version management
  app.use(writeGateRoutes.routes())              // Hermes Agent write approval review
  app.use(petdexRoutes.routes())
  app.use(petRoutes.routes())
}
