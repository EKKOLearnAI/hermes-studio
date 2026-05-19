import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { stripLegacyApiServerGatewayConfig } from '../config-helpers'
import { logger } from '../logger'
import { safeFileStore } from '../safe-file-store'
import { getProfileDir, listProfileNamesFromDisk } from './hermes-profile'
import { startGatewayRunManaged } from './gateway-runner'

const execFileAsync = promisify(execFile)

function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

function isDockerRuntime(): boolean {
  return existsSync('/.dockerenv')
}

function isTermuxRuntime(): boolean {
  const prefix = process.env.PREFIX || ''
  return !!process.env.TERMUX_VERSION ||
    prefix.includes('/com.termux/') ||
    existsSync('/data/data/com.termux/files/usr')
}

export function gatewayStatusLooksRunning(output: string): boolean {
  const text = output.toLowerCase()
  if (text.includes('gateway is not running') || text.includes('not running')) return false
  return text.includes('gateway is running') || text.includes('running')
}

export function gatewayStatusLooksRuntimeLocked(output: string): boolean {
  const text = output.toLowerCase()
  return text.includes('runtime lock is already held')
    || text.includes('gateway runtime lock is already held')
    || text.includes('already held by another instance')
}

export async function isGatewayRunningForProfile(hermesBin: string, profileDir: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(hermesBin, ['gateway', 'status'], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    return gatewayStatusLooksRunning(`${stdout}\n${stderr}`)
  } catch (err: any) {
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`
    if (gatewayStatusLooksRuntimeLocked(output)) {
      logger.info({ profileDir }, 'Hermes gateway status reported runtime lock held; treating gateway as already running')
      return true
    }
    if (output.trim()) {
      logger.warn({ err, profileDir }, 'Hermes gateway status failed; treating as not running')
    }
    return false
  }
}

async function startGatewayForProfile(hermesBin: string, profile: string, profileDir: string): Promise<void> {
  if (isDockerRuntime() || isTermuxRuntime()) {
    const result = startGatewayRunManaged(hermesBin, { profileDir })
    logger.info(
      '[gateway-autostart] gateway started via background run profile=%s home=%s pid=%s',
      profile,
      profileDir,
      result.pid || 'unknown',
    )
    return
  }

  try {
    await execFileAsync(hermesBin, ['gateway', 'start'], {
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    logger.info('[gateway-autostart] gateway started via Hermes CLI service profile=%s home=%s', profile, profileDir)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes CLI gateway start failed; falling back to background run profile=%s home=%s', profile, profileDir)
    const result = startGatewayRunManaged(hermesBin, { profileDir })
    logger.info(
      '[gateway-autostart] gateway started via fallback background run profile=%s home=%s pid=%s',
      profile,
      profileDir,
      result.pid || 'unknown',
    )
  }
}

export async function clearApiServerForProfile(profileDir: string): Promise<void> {
  const configPath = join(profileDir, 'config.yaml')
  try {
    await safeFileStore.updateYaml(configPath, (config) => {
      const result = stripLegacyApiServerGatewayConfig(config)
      return { data: result.config, result: undefined, write: result.changed }
    }, { backup: true })
  } catch (err) {
    logger.warn(err, 'Failed to clear legacy api_server gateway config before gateway startup: %s', profileDir)
  }
}

export async function ensureProfileGatewaysRunning(): Promise<void> {
  const hermesBin = resolveHermesBin()
  const profiles = listProfileNamesFromDisk()
  for (const profile of profiles) {
    const profileDir = getProfileDir(profile)
    const running = await isGatewayRunningForProfile(hermesBin, profileDir)
    if (running) {
      logger.info('[gateway-autostart] gateway already running profile=%s home=%s', profile, profileDir)
      continue
    }

    await clearApiServerForProfile(profileDir)
    await startGatewayForProfile(hermesBin, profile, profileDir)
  }
}
