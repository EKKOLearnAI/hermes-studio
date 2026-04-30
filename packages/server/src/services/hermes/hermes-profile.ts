import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync, writeFileSync } from 'fs'

const HERMES_BASE = resolve(homedir(), '.hermes')

function activeProfileFile(): string {
  return join(HERMES_BASE, 'active_profile')
}

function profileDir(name: string): string {
  return name === 'default' ? HERMES_BASE : join(HERMES_BASE, 'profiles', name)
}

export function normalizeActiveProfile(): string {
  const activeFile = activeProfileFile()
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    if (!name || name === 'default') return 'default'
    if (existsSync(profileDir(name))) return name
    writeFileSync(activeFile, 'default\n', 'utf-8')
    return 'default'
  } catch {
    return 'default'
  }
}

/**
 * Get the active profile's home directory.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getActiveProfileDir(): string {
  return profileDir(normalizeActiveProfile())
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
  return normalizeActiveProfile()
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
