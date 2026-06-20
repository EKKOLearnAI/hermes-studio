import type { Context, Next } from 'koa'

// Shared route modules
import { healthRoutes } from './health'
import { webhookRoutes } from './webhook'
import { uploadRoutes } from './upload'
import { updateRoutes } from './update'
import { authPublicRoutes, authProtectedRoutes } from './auth'
import { devicePublicRoutes, deviceRoutes } from './devices'
import { codingAgentRoutes } from './coding-agents'
import { apiDocsRoutes } from './api-docs'
import { claudeCodeProxyRoutes } from './claude-code-proxy'
import { codexProxyRoutes } from './codex-proxy'

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
import { xaiAuthRoutes } from './hermes/xai-auth'
import { anthropicAuthRoutes } from './hermes/anthropic-auth'
import { geminiAuthRoutes } from './hermes/gemini-auth'
import { weixinRoutes } from './hermes/weixin'
import { fileRoutes } from './hermes/files'
import { downloadRoutes } from './hermes/download'
import { jobRoutes } from './hermes/jobs'
import { cronHistoryRoutes } from './hermes/cron-history'
import { kanbanRoutes } from './hermes/kanban'
import { ttsRoutes, ttsProtectedRoutes } from './hermes/tts'
import { sttProtectedRoutes } from './hermes/stt'
import { mcuFirmwareRoutes } from './hermes/mcu-firmware'
import { mediaRoutes } from './hermes/media'
import { groupChatRoutes, setGroupChatServer } from './hermes/group-chat'
import { chatRunRoutes } from './hermes/chat-run'
import { performanceMonitorRoutes } from './hermes/performance-monitor'
import { mcpRoutes } from './hermes/mcp'
import { runtimeVersionRoutes } from './hermes/runtime-versions'
import { writeGateRoutes } from './hermes/write-gate'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes.
 */
export function registerRoutes(app: any, authMiddleware: Array<(ctx: Context, next: Next) => Promise<void>>) {
  // --- Public routes (no auth required) ---
  app.use(healthRoutes.routes())
  app.use(webhookRoutes.routes())
  app.use(authPublicRoutes.routes())
  app.use(devicePublicRoutes.routes())
  app.use(claudeCodeProxyRoutes.routes())
  app.use(codexProxyRoutes.routes())
  app.use(ttsRoutes.routes())
  app.use(apiDocsRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  authMiddleware.forEach((middleware) => app.use(middleware))

  // --- Protected routes (auth required) ---
  app.use(authProtectedRoutes.routes())
  app.use(deviceRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(updateRoutes.routes())           // Must be before proxy (proxy catch-all matches everything)
  app.use(codingAgentRoutes.routes())
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
  app.use(xaiAuthRoutes.routes())
  app.use(anthropicAuthRoutes.routes())
  app.use(geminiAuthRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(chatRunRoutes.routes())
  app.use(groupChatRoutes.routes())
  app.use(fileRoutes.routes())
  app.use(downloadRoutes.routes())
  app.use(jobRoutes.routes())
  app.use(cronHistoryRoutes.routes())
  app.use(kanbanRoutes.routes())
  app.use(ttsProtectedRoutes.routes())
  app.use(sttProtectedRoutes.routes())
  app.use(mcuFirmwareRoutes.routes())
  app.use(mediaRoutes.routes())
  app.use(performanceMonitorRoutes.routes())
  app.use(mcpRoutes.routes())                   // MCP management
  app.use(runtimeVersionRoutes.routes())         // Runtime and version management
  app.use(writeGateRoutes.routes())              // Hermes Agent write approval review
}
