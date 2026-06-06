import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { readAppConfig, type GatewayAutoStartConfig } from '../app-config'
import { stripLegacyApiServerGatewayConfig } from '../config-helpers'
import { logger } from '../logger'
import { safeFileStore } from '../safe-file-store'
import { getProfileDir, listProfileNamesFromDisk } from './hermes-profile'
import { startGatewayRunManaged } from './gateway-runner'
import { parseGatewayStatusesFromProfileList } from './profile-list-parser'
import { execHermesWithBin } from './hermes-process'

const execFileAsync = promisify(execFile)
const GATEWAY_RUNTIME_FILES = ['gateway.pid', 'gateway.lock', 'gateway_state.json'] as const

const RESERVED_PROFILE_NAMES = new Set([
  'hermes', 'test', 'tmp', 'root', 'sudo',
])

const HERMES_SUBCOMMAND_PROFILE_NAMES = new Set([
  'chat', 'model', 'gateway', 'setup', 'whatsapp', 'login', 'logout',
  'status', 'cron', 'doctor', 'dump', 'config', 'pairing', 'skills', 'tools',
  'mcp', 'sessions', 'insights', 'version', 'update', 'uninstall',
  'profile', 'plugins', 'honcho', 'acp',
])

function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || 'hermes'
}

function isReservedProfileName(profile: string): boolean {
  const normalized = String(profile || '').trim().toLowerCase()
  if (!normalized || normalized === 'default') return false
  return RESERVED_PROFILE_NAMES.has(normalized) || HERMES_SUBCOMMAND_PROFILE_NAMES.has(normalized)
}

function normalizedProfileList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = String(value || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export function selectProfilesForGatewayAutostart(
  profiles: string[],
  policy?: GatewayAutoStartConfig,
): string[] {
  const known = new Set(profiles)
  if (policy?.enabled === false) return []

  const hasIncludePolicy = Array.isArray(policy?.include)
  const include = normalizedProfileList(policy?.include).filter(name => known.has(name))
  const exclude = new Set(normalizedProfileList(policy?.exclude))
  const candidates = hasIncludePolicy ? include : profiles

  return candidates.filter(name => !exclude.has(name))
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

function envFlagEnabled(name: string): boolean {
  return envValueFlagEnabled(process.env[name])
}

function envValueFlagEnabled(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function envFlagEnabledIn(env: NodeJS.ProcessEnv, name: string): boolean {
  return envValueFlagEnabled(env[name])
}

function envFlagDisabledIn(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = String(env[name] || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

export function shouldRecoverWindowsDesktopGatewayOrphans(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'win32') return false
  if (!envFlagEnabledIn(env, 'HERMES_DESKTOP')) return false
  return !envFlagDisabledIn(env, 'HERMES_WEB_UI_DISABLE_GATEWAY_STARTUP_RECOVERY')
}

function listGatewayRuntimeProfileDirs(hermesHome?: string): string[] {
  const base = hermesHome || getProfileDir('default')
  const dirs = new Set<string>([base])
  const profilesRoot = join(base, 'profiles')
  try {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.trim()) {
        dirs.add(join(profilesRoot, entry.name))
      }
    }
  } catch {}
  return [...dirs]
}

function readGatewayRuntimePid(path: string, fileName: string): number | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (fileName === 'gateway_state.json') {
      const state = String(data?.gateway_state || '').toLowerCase()
      if (state && state !== 'running' && state !== 'starting') return null
    }
    const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function taskkillWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
  })
}

export interface GatewayStartupRecoveryResult {
  attempted: boolean
  profileDirs: string[]
  stoppedProfileDirs: string[]
  killedPids: number[]
  deletedFiles: string[]
  errors: number
}

export async function recoverWindowsDesktopGatewayOrphans(opts: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  hermesHome?: string
  isAlive?: (pid: number) => boolean
  stopGateway?: (profileDir: string) => Promise<void>
  execTaskkill?: (pid: number) => Promise<void>
  unlinkFile?: (path: string) => void
} = {}): Promise<GatewayStartupRecoveryResult> {
  const platform = opts.platform || process.platform
  const env = opts.env || process.env
  if (!shouldRecoverWindowsDesktopGatewayOrphans(platform, env)) {
    return { attempted: false, profileDirs: [], stoppedProfileDirs: [], killedPids: [], deletedFiles: [], errors: 0 }
  }

  const isAlive = opts.isAlive || isProcessAlive
  const stopGateway = opts.stopGateway || (async (profileDir: string) => {
    await execHermesWithBin(resolveHermesBin(), ['gateway', 'stop'], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
  })
  const execTaskkill = opts.execTaskkill || taskkillWindowsProcessTree
  const unlinkFile = opts.unlinkFile || unlinkSync
  const profileDirs = listGatewayRuntimeProfileDirs(opts.hermesHome)
  const pids = new Set<number>()

  for (const profileDir of profileDirs) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const pid = readGatewayRuntimePid(join(profileDir, fileName), fileName)
      if (pid !== null) pids.add(pid)
    }
  }

  const stoppedProfileDirs: string[] = []
  const killedPids: number[] = []
  const deletedFiles: string[] = []
  let errors = 0

  for (const profileDir of profileDirs) {
    try {
      await stopGateway(profileDir)
      stoppedProfileDirs.push(profileDir)
    } catch (err) {
      errors += 1
      logger.warn(err, '[gateway-autostart] Hermes gateway stop failed during Windows desktop startup recovery profileDir=%s', profileDir)
    }
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    try {
      await execTaskkill(pid)
      killedPids.push(pid)
    } catch (err) {
      errors += 1
      logger.warn(err, '[gateway-autostart] failed to recover orphan Windows gateway PID %d', pid)
    }
  }

  for (const profileDir of profileDirs) {
    for (const fileName of GATEWAY_RUNTIME_FILES) {
      const filePath = join(profileDir, fileName)
      if (!existsSync(filePath)) continue
      try {
        unlinkFile(filePath)
        deletedFiles.push(filePath)
      } catch (err) {
        errors += 1
        logger.warn(err, '[gateway-autostart] failed to remove gateway runtime file %s', filePath)
      }
    }
  }

  if (killedPids.length || deletedFiles.length) {
    logger.warn(
      '[gateway-autostart] recovered Windows desktop gateway runtime before startup killedPids=%s deletedFiles=%s',
      killedPids.join(',') || 'none',
      deletedFiles.length,
    )
  }

  return { attempted: true, profileDirs, stoppedProfileDirs, killedPids, deletedFiles, errors }
}

let windowsDesktopGatewayRecoveryAttempted = false

async function recoverWindowsDesktopGatewayOrphansOnce(): Promise<void> {
  if (windowsDesktopGatewayRecoveryAttempted) return
  windowsDesktopGatewayRecoveryAttempted = true
  await recoverWindowsDesktopGatewayOrphans()
}

export function shouldUseManagedGatewayRun(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_MANAGED_GATEWAY') ||
    isDockerRuntime() ||
    isTermuxRuntime() ||
    process.platform === 'win32'
}

export function shouldUseManagedGatewayRunForAutostart(platform: NodeJS.Platform = process.platform): boolean {
  return envFlagEnabled('HERMES_WEB_UI_MANAGED_GATEWAY') ||
    isDockerRuntime() ||
    isTermuxRuntime() ||
    platform === 'win32'
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function readJsonPid(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function gatewayStateLooksRunningForProfile(profileDir: string): boolean {
  const statePath = join(profileDir, 'gateway_state.json')
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'))
      const state = String(data?.gateway_state || '').toLowerCase()
      const pid = typeof data?.pid === 'number' ? data.pid : parseInt(String(data?.pid || ''), 10)
      if ((state === 'running' || state === 'starting') && isProcessAlive(pid)) return true
    } catch {}
  }

  const pid = readJsonPid(join(profileDir, 'gateway.pid'))
  return pid !== null && isProcessAlive(pid)
}

export function parseGatewayStatusesFromProfileListOutput(stdout: string, profileNames = listProfileNamesFromDisk()): Map<string, string> {
  return parseGatewayStatusesFromProfileList(stdout, profileNames)
}

async function listGatewayStatusesFromProfileList(hermesBin: string): Promise<Map<string, string>> {
  const { stdout } = await execHermesWithBin(hermesBin, ['profile', 'list'], {
    timeout: 10000,
    windowsHide: true,
  })
  return parseGatewayStatusesFromProfileListOutput(stdout)
}

async function isGatewayRunningInProfileList(hermesBin: string, profile: string): Promise<boolean> {
  const statuses = await listGatewayStatusesFromProfileList(hermesBin)
  const status = statuses.get(profile)
  return status !== undefined && gatewayStatusLooksRunning(status)
}

export async function isGatewayRunningForProfile(hermesBin: string, profileDir: string): Promise<boolean> {
  if (gatewayStateLooksRunningForProfile(profileDir)) return true

  try {
    const { stdout, stderr } = await execHermesWithBin(hermesBin, ['gateway', 'status'], {
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

async function waitForGatewayRunning(hermesBin: string, profile: string, profileDir: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await isGatewayRunningInProfileList(hermesBin, profile)) return true
    } catch (err) {
      logger.warn(err, '[gateway-autostart] Hermes profile list check failed while waiting for gateway profile=%s', profile)
    }
    if (await isGatewayRunningForProfile(hermesBin, profileDir)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

async function stopGatewayForProfile(hermesBin: string, profile: string, profileDir: string): Promise<void> {
  try {
    await execHermesWithBin(hermesBin, ['gateway', 'stop'], {
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    logger.info('[gateway-autostart] gateway stopped profile=%s home=%s', profile, profileDir)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes CLI gateway stop failed before restart profile=%s home=%s', profile, profileDir)
  }
}

export async function startGatewayForProfile(
  hermesBin: string,
  profile: string,
  profileDir: string,
  opts: { managedRun?: boolean } = {},
): Promise<void> {
  if (opts.managedRun ?? shouldUseManagedGatewayRun()) {
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
    await execHermesWithBin(hermesBin, ['gateway', 'start'], {
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

export async function getGatewayRuntimeStatusForProfile(profile: string): Promise<{ running: boolean; profile: string }> {
  const hermesBin = resolveHermesBin()
  const profileDir = getProfileDir(profile)
  const running = await isGatewayRunningForProfile(hermesBin, profileDir)
  return { running, profile }
}

export async function restartGatewayForProfile(profile: string): Promise<{ running: boolean; profile: string }> {
  const hermesBin = resolveHermesBin()
  const profileDir = getProfileDir(profile)
  await clearApiServerForProfile(profileDir)
  await stopGatewayForProfile(hermesBin, profile, profileDir)

  try {
    await startGatewayForProfile(hermesBin, profile, profileDir, { managedRun: shouldUseManagedGatewayRun() })
  } catch (err) {
    logger.error(err, '[gateway-autostart] Hermes gateway restart failed profile=%s home=%s', profile, profileDir)
    throw err
  }

  const running = await waitForGatewayRunning(hermesBin, profile, profileDir)
  if (!running) throw new Error('Hermes gateway start completed but gateway did not report running within timeout')
  return { running, profile }
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
  await recoverWindowsDesktopGatewayOrphansOnce()

  const hermesBin = resolveHermesBin()
  const discoveredProfiles = listProfileNamesFromDisk()
  const { gatewayAutoStart } = await readAppConfig()
  const profiles = selectProfilesForGatewayAutostart(discoveredProfiles, gatewayAutoStart)
  const skippedProfiles = discoveredProfiles.filter(profile => !profiles.includes(profile))
  if (skippedProfiles.length > 0) {
    logger.info(
      '[gateway-autostart] skipping profiles excluded by gatewayAutoStart policy profiles=%s',
      skippedProfiles.join(','),
    )
  }
  let gatewayStatuses: Map<string, string> | undefined
  try {
    gatewayStatuses = await listGatewayStatusesFromProfileList(hermesBin)
  } catch (err) {
    logger.warn(err, '[gateway-autostart] Hermes profile list failed; falling back to per-profile gateway status checks')
  }

  for (const profile of profiles) {
    if (isReservedProfileName(profile)) {
      logger.warn('[gateway-autostart] skipping reserved profile name during gateway autostart profile=%s', profile)
      continue
    }

    const profileDir = getProfileDir(profile)
    const status = gatewayStatuses?.get(profile)
    const running = status !== undefined && gatewayStatusLooksRunning(status)
      ? true
      : await isGatewayRunningForProfile(hermesBin, profileDir)
    if (running) {
      logger.info('[gateway-autostart] gateway already running profile=%s home=%s status=%s', profile, profileDir, status || 'status-check')
      continue
    }

    await clearApiServerForProfile(profileDir)
    await startGatewayForProfile(hermesBin, profile, profileDir, { managedRun: shouldUseManagedGatewayRunForAutostart() })
    const ready = await waitForGatewayRunning(hermesBin, profile, profileDir)
    if (!ready) {
      logger.warn('[gateway-autostart] gateway start completed but did not report running within timeout profile=%s home=%s', profile, profileDir)
    }
  }
}
