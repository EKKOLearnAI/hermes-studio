import { defineAsyncComponent, type Component } from 'vue'
import {
  getAuroraAppWindowMeta as getAuroraManifestAppWindowMeta,
  type AuroraAppKind,
  type AuroraAppWindow,
} from './capability-manifest'

export type { AuroraAppKind, AuroraAppWindow }

export interface AuroraAppWindowDefinition extends AuroraAppWindow {
  component: Component
}

function withComponent(kind: AuroraAppKind, component: Component): AuroraAppWindowDefinition {
  return {
    ...getAuroraManifestAppWindowMeta(kind),
    component,
  }
}

export const AURORA_APP_WINDOW_REGISTRY: Readonly<Record<AuroraAppKind, AuroraAppWindowDefinition>> = {
  'quant-lab': withComponent('quant-lab', defineAsyncComponent(() => import('@/views/hermes/QuantLabView.vue'))),
  tradingview: withComponent('tradingview', defineAsyncComponent(() => import('@/components/hermes/aurora/TradingViewApp.vue'))),
  mirofish: withComponent('mirofish', defineAsyncComponent(() => import('@/components/hermes/aurora/MiroFishAppEntry.vue'))),
  'mirofish-arena': withComponent('mirofish-arena', defineAsyncComponent(() => import('@/components/hermes/aurora/MiroFishArena.vue'))),
  'mirofish-graph': withComponent('mirofish-graph', defineAsyncComponent(() => import('@/components/hermes/aurora/MiroFishGraphApp.vue'))),
  'life-os': withComponent('life-os', defineAsyncComponent(() => import('@/views/hermes/LifeOSView.vue'))),
  kanban: withComponent('kanban', defineAsyncComponent(() => import('@/views/hermes/KanbanView.vue'))),
  memory: withComponent('memory', defineAsyncComponent(() => import('@/views/hermes/MemoryView.vue'))),
  files: withComponent('files', defineAsyncComponent(() => import('@/views/hermes/FilesView.vue'))),
  'video-studio': withComponent('video-studio', defineAsyncComponent(() => import('@/components/hermes/aurora/VideoStudioApp.vue'))),
  browser: withComponent('browser', defineAsyncComponent(() => import('@/components/hermes/aurora/BrowserApp.vue'))),
  jobs: withComponent('jobs', defineAsyncComponent(() => import('@/views/hermes/JobsView.vue'))),
  history: withComponent('history', defineAsyncComponent(() => import('@/views/hermes/HistoryView.vue'))),
  models: withComponent('models', defineAsyncComponent(() => import('@/views/hermes/ModelsView.vue'))),
  profiles: withComponent('profiles', defineAsyncComponent(() => import('@/views/hermes/ProfilesView.vue'))),
  channels: withComponent('channels', defineAsyncComponent(() => import('@/views/hermes/ChannelsView.vue'))),
  'group-chat': withComponent('group-chat', defineAsyncComponent(() => import('@/views/hermes/GroupChatView.vue'))),
  gateways: withComponent('gateways', defineAsyncComponent(() => import('@/views/hermes/GatewaysView.vue'))),
  logs: withComponent('logs', defineAsyncComponent(() => import('@/views/hermes/LogsView.vue'))),
  usage: withComponent('usage', defineAsyncComponent(() => import('@/views/hermes/UsageView.vue'))),
  skills: withComponent('skills', defineAsyncComponent(() => import('@/views/hermes/SkillsView.vue'))),
  plugins: withComponent('plugins', defineAsyncComponent(() => import('@/views/hermes/PluginsView.vue'))),
  'code-intelligence': withComponent('code-intelligence', defineAsyncComponent(() => import('@/views/hermes/CodeIntelligenceView.vue'))),
  'system-status': withComponent('system-status', defineAsyncComponent(() => import('@/views/hermes/SystemStatusView.vue'))),
  settings: withComponent('settings', defineAsyncComponent(() => import('@/views/hermes/SettingsView.vue'))),
}

export function getAuroraAppWindowDefinition(kind: AuroraAppKind) {
  return AURORA_APP_WINDOW_REGISTRY[kind]
}

export function getAuroraAppWindowMeta(kind: AuroraAppKind): AuroraAppWindow {
  const { component: _component, ...meta } = getAuroraAppWindowDefinition(kind)
  return meta
}
