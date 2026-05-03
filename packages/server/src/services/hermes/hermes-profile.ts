import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'

const HERMES_BASE = process.env.HERMES_HOME || resolve(homedir(), '.hermes')

/**
 * Get the active profile's home directory.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getActiveProfileDir(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    if (name && name !== 'default') {
      const dir = join(HERMES_BASE, 'profiles', name)
      if (existsSync(dir)) return dir
    }
  } catch { }
  return HERMES_BASE
}

/**
 * Get the active profile's config.yaml path.
 */
export function getActiveConfigPath(): string {
  return join(getActiveProfileDir(), 'config.yaml')
}

/**
 * Get the active profile's auth.json path.
 */
export function getActiveAuthPath(): string {
  return join(getActiveProfileDir(), 'auth.json')
}

/**
 * Get the active profile's .env path.
 */
export function getActiveEnvPath(): string {
  return join(getActiveProfileDir(), '.env')
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

/**
 * Get profile directory by name.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getProfileDir(name: string): string {
  if (!name || name === 'default') return HERMES_BASE
  const dir = join(HERMES_BASE, 'profiles', name)
  return existsSync(dir) ? dir : HERMES_BASE
}
