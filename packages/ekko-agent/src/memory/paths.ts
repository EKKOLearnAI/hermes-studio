import { homedir } from 'node:os'
import { EkkoDirectoryManager } from '../directories'

export interface EkkoDataPathOptions {
  baseDirectory?: string
  env?: Record<string, string | undefined>
  homeDir?: string
}

export function resolveEkkoDataDirectory(options: EkkoDataPathOptions = {}): string {
  return new EkkoDirectoryManager(options.baseDirectory || options.homeDir || homedir()).rootDirectory
}

export function resolveEkkoDatabasePath(options: EkkoDataPathOptions = {}): string {
  return new EkkoDirectoryManager(options.baseDirectory || options.homeDir || homedir()).databasePath
}

export function isEkkoDevelopmentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test' && env.VITEST !== 'true'
}
