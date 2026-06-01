import {
  AURORA_APP_CAPABILITIES,
  type AuroraAppKind,
} from './capability-manifest'

export const AURORA_LEGACY_ROUTE_APP_MAP = {
  '/hermes/history': 'history',
  '/hermes/jobs': 'jobs',
  '/hermes/kanban': 'kanban',
  '/hermes/quant-lab': 'quant-lab',
  '/hermes/life-os': 'life-os',
  '/hermes/models': 'models',
  '/hermes/profiles': 'profiles',
  '/hermes/logs': 'logs',
  '/hermes/usage': 'usage',
  '/hermes/skills-usage': 'usage',
  '/hermes/skills': 'skills',
  '/hermes/plugins': 'plugins',
  '/hermes/memory': 'memory',
  '/hermes/settings': 'settings',
  '/hermes/gateways': 'gateways',
  '/hermes/system-status': 'system-status',
  '/hermes/code-intelligence': 'code-intelligence',
  '/hermes/channels': 'channels',
  '/hermes/group-chat': 'group-chat',
  '/hermes/files': 'files',
} as const satisfies Record<string, AuroraAppKind>

export const AURORA_RETIRED_LEGACY_ROUTES = new Set(['/hermes/terminal'])

export function getAuroraAppKindForLegacyRoute(path: string): AuroraAppKind | null {
  return AURORA_LEGACY_ROUTE_APP_MAP[path as keyof typeof AURORA_LEGACY_ROUTE_APP_MAP] || null
}

export function isAuroraAppKind(value: unknown): value is AuroraAppKind {
  if (typeof value !== 'string') return false
  return value in AURORA_APP_CAPABILITIES
}
