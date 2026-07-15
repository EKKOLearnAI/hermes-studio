import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface EkkoDataPathOptions {
  webUiHome?: string
  env?: Record<string, string | undefined>
  homeDir?: string
  packageRoot?: string
}

export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  const env = options.env ?? process.env
  if (isEkkoDevelopmentEnvironment(env)) {
    const packageRoot = options.packageRoot || resolve(__dirname, '..', '..')
    return join(packageRoot, 'sql-data')
  }
  const configuredHome = options.webUiHome || env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  const webUiHome = configuredHome ? resolve(configuredHome) : join(options.homeDir || homedir(), '.hermes-web-ui')
  return join(webUiHome, 'ekko')
}

export function resolveEkkoDatabasePath(options: EkkoDataPathOptions = {}): string {
  const env = options.env ?? process.env
  const databaseName = isEkkoDevelopmentEnvironment(env) ? 'ekko-agent.db' : 'ekko.db'
  return join(resolveEkkoDataDirectory(options), databaseName)
}

export function isEkkoDevelopmentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test' && env.VITEST !== 'true'
}
