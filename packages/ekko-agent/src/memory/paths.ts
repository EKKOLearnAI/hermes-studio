import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EkkoDirectoryManager } from '../directories'

export interface EkkoDataPathOptions {
  baseDirectory?: string
  env?: Record<string, string | undefined>
  homeDir?: string
  packageRoot?: string
}

export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  if (isEkkoDevelopmentEnvironment(options.env ?? process.env)) {
    const packageRoot = options.packageRoot || resolve(__dirname, '..', '..')
    return join(packageRoot, 'sql-data')
  }
  return new EkkoDirectoryManager(options.baseDirectory || options.homeDir || homedir()).rootDirectory
}

export function resolveEkkoDatabasePath(options: EkkoDataPathOptions = {}): string {
  const databaseName = isEkkoDevelopmentEnvironment(options.env ?? process.env)
    ? 'ekko-agent.db'
    : 'ekko.db'
  return join(resolveEkkoDataDirectory(options), databaseName)
}

export function isEkkoDevelopmentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test' && env.VITEST !== 'true'
}
