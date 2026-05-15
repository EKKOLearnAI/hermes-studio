import { resolve } from 'path'
import { homedir } from 'os'

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function normalizeUrl(value: string | undefined): string {
  return (value || '').trim().replace(/\/+$/, '')
}

function getDefaultUpdateCliBin(packageName: string): string {
  const packageBasename = packageName.split('/').filter(Boolean).pop() || packageName
  return `${packageBasename}.mjs`
}

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  uploadDir: process.env.UPLOAD_DIR || resolve(homedir(), '.hermes-web-ui', 'upload'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: process.env.CORS_ORIGINS || '*',
  /** Session store: 'local' (self-built SQLite) or 'remote' (Hermes CLI) */
  sessionStore: (process.env.SESSION_STORE || 'local') as 'local' | 'remote',
  update: {
    enabled: parseBoolean(process.env.WEBUI_UPDATE_ENABLED, false),
    packageName: (process.env.WEBUI_UPDATE_PACKAGE || '').trim(),
    registry: normalizeUrl(process.env.WEBUI_UPDATE_REGISTRY),
    sourceLabel: (process.env.WEBUI_UPDATE_SOURCE_LABEL || '').trim(),
    cliBin: (process.env.WEBUI_UPDATE_CLI_BIN || '').trim(),
  },
}

if (!config.update.sourceLabel && config.update.registry) {
  config.update.sourceLabel = config.update.registry
}

if (!config.update.cliBin && config.update.packageName) {
  config.update.cliBin = getDefaultUpdateCliBin(config.update.packageName)
}
