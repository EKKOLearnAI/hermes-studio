import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { dirname, join } from 'path'
import { getProfileDir } from './hermes-profile'
import { saveEnvValueForProfile } from '../config-helpers'
import { createHealthScaleReading } from './health-state'

const execFileAsync = promisify(execFile)

const ENV_KEYS = {
  enabled: 'S400_SYNC_ENABLED',
  source: 'S400_SYNC_SOURCE',
  username: 'S400_XIAOMI_USERNAME',
  password: 'S400_XIAOMI_PASSWORD',
  region: 'S400_XIAOMI_REGION',
  scaleModel: 'S400_SCALE_MODEL',
  scaleconnectPath: 'S400_SCALECONNECT_PATH',
}

const DEFAULT_SOURCE = 'xiaomihome'
const DEFAULT_REGION = 'cn'
const DEFAULT_SCALE_MODEL = 'yunmai.scales.ms103'

export type ScaleSyncSource = 'mifitness' | 'xiaomihome'
export type ScaleSyncStatus = 'synced' | 'skipped' | 'failed'

export interface ScaleSyncSettings {
  enabled: boolean
  source: ScaleSyncSource
  username: string
  hasPassword: boolean
  passwordMasked: string
  region: string
  scaleModel: string
  scaleconnectPath: string
  configured: boolean
}

export interface ScaleSyncSettingsInput {
  enabled?: unknown
  source?: unknown
  username?: unknown
  password?: unknown
  clearPassword?: unknown
  region?: unknown
  scaleModel?: unknown
  scaleconnectPath?: unknown
}

export interface ScaleSyncResult {
  status: ScaleSyncStatus
  reason?: string
  command?: string
  importedCount: number
  readings: Array<Record<string, unknown>>
  stderr?: string
  verificationUrl?: string
}

export async function getScaleSyncSettings(profile = 'default'): Promise<ScaleSyncSettings> {
  const env = await readProfileEnv(profile)
  return settingsFromEnv(env)
}

export async function updateScaleSyncSettings(input: ScaleSyncSettingsInput, profile = 'default'): Promise<ScaleSyncSettings> {
  const current = await readProfileEnv(profile)
  const updates: Record<string, string> = {}

  if (typeof input.enabled !== 'undefined') updates[ENV_KEYS.enabled] = boolValue(input.enabled) ? 'true' : 'false'
  if (typeof input.source !== 'undefined') updates[ENV_KEYS.source] = normalizeSource(input.source)
  if (typeof input.username !== 'undefined') updates[ENV_KEYS.username] = singleLine(input.username)
  if (typeof input.region !== 'undefined') updates[ENV_KEYS.region] = singleLine(input.region) || DEFAULT_REGION
  if (typeof input.scaleModel !== 'undefined') updates[ENV_KEYS.scaleModel] = singleLine(input.scaleModel) || DEFAULT_SCALE_MODEL
  if (typeof input.scaleconnectPath !== 'undefined') updates[ENV_KEYS.scaleconnectPath] = singleLine(input.scaleconnectPath)

  const password = typeof input.password === 'string' ? singleLine(input.password) : ''
  if (password) {
    updates[ENV_KEYS.password] = password
  } else if (boolValue(input.clearPassword)) {
    updates[ENV_KEYS.password] = ''
  }

  for (const [key, value] of Object.entries(updates)) {
    await saveEnvValueForProfile(profile, key, value)
  }

  return settingsFromEnv({ ...current, ...updates })
}

export async function runScaleSync(profile = 'default', actor = 'system'): Promise<ScaleSyncResult> {
  const env = await readProfileEnv(profile)
  const settings = settingsFromEnv(env)
  if (!settings.enabled) return skipped('disabled', settings)
  if (!settings.username || !env[ENV_KEYS.password]) return skipped('missing_xiaomi_credentials', settings)
  if (!settings.scaleconnectPath) return skipped('missing_scaleconnect_path', settings)

  const config = buildSmartScaleConnectConfig(settings, env[ENV_KEYS.password])
  const command = `${settings.scaleconnectPath} -c <redacted-json>`
  try {
    const { stdout, stderr } = await execFileAsync(settings.scaleconnectPath, ['-c', JSON.stringify(config)], {
      cwd: dirname(settings.scaleconnectPath),
      env: buildScaleconnectEnv(),
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 4,
      windowsHide: true,
    })
    const payloads = parseScaleConnectOutput(stdout)
    const readings = payloads.map(payload => createHealthScaleReading(payload, actor, profile))
    const stderrText = trimOrUndefined(stderr)
    const classified = classifyScaleconnectStderr(stderrText)
    if (classified) {
      return { status: 'failed', command, importedCount: readings.length, readings, stderr: stderrText, ...classified }
    }
    return { status: 'synced', command, importedCount: readings.length, readings, stderr: trimOrUndefined(stderr) }
  } catch (err: any) {
    return {
      status: 'failed',
      reason: err?.code === 'ENOENT' ? 'scaleconnect_not_found' : 'scaleconnect_failed',
      command,
      importedCount: 0,
      readings: [],
      stderr: trimOrUndefined(String(err?.stderr || err?.message || '')),
    }
  }
}

function settingsFromEnv(env: Record<string, string>): ScaleSyncSettings {
  const source = normalizeSource(env[ENV_KEYS.source] || DEFAULT_SOURCE)
  const username = env[ENV_KEYS.username] || ''
  const hasPassword = Boolean(env[ENV_KEYS.password])
  const scaleconnectPath = env[ENV_KEYS.scaleconnectPath] || defaultScaleconnectPath()
  const settings: ScaleSyncSettings = {
    enabled: enabledValue(env[ENV_KEYS.enabled]),
    source,
    username,
    hasPassword,
    passwordMasked: hasPassword ? '********' : '',
    region: env[ENV_KEYS.region] || DEFAULT_REGION,
    scaleModel: env[ENV_KEYS.scaleModel] || DEFAULT_SCALE_MODEL,
    scaleconnectPath,
    configured: false,
  }
  settings.configured = Boolean(settings.enabled && settings.username && settings.hasPassword && settings.scaleconnectPath)
  return settings
}

function defaultScaleconnectPath(): string {
  const localAppData = process.env.LOCALAPPDATA || ''
  if (!localAppData) return ''
  const candidate = join(localAppData, 'hermes', 'tools', process.platform === 'win32' ? 'scaleconnect.exe' : 'scaleconnect')
  return existsSync(candidate) ? candidate : ''
}

function buildSmartScaleConnectConfig(settings: ScaleSyncSettings, password: string): Record<string, unknown> {
  const from = settings.source === 'mifitness'
    ? `mifitness ${settings.username} ${password} ${settings.scaleModel}`
    : `xiaomihome ${settings.username} ${password} ${settings.region} ${settings.scaleModel}`
  return {
    sync1: {
      disabled: false,
      timezone: 'Asia/Shanghai',
      from,
      to: 'json stdout',
    },
  }
}

function parseScaleConnectOutput(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  if (isRecord(parsed) && Array.isArray(parsed.readings)) return parsed.readings.filter(isRecord)
  if (isRecord(parsed)) return [parsed]
  return []
}

async function readProfileEnv(profile: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(join(getProfileDir(profile), '.env'), 'utf-8'))
  } catch {
    return {}
  }
}

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    result[key] = trimmed.slice(eq + 1).trim()
  }
  return result
}

function normalizeSource(value: unknown): ScaleSyncSource {
  return String(value).trim().toLowerCase() === 'mifitness' ? 'mifitness' : 'xiaomihome'
}

function buildScaleconnectEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const existingProxy = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy
  const proxyUrl = existingProxy || detectWindowsProxyUrl()
  if (proxyUrl) {
    env.HTTP_PROXY ||= proxyUrl
    env.HTTPS_PROXY ||= proxyUrl
    env.ALL_PROXY ||= proxyUrl
    env.http_proxy ||= proxyUrl
    env.https_proxy ||= proxyUrl
    env.all_proxy ||= proxyUrl
  }
  return env
}

function detectWindowsProxyUrl(): string {
  if (process.platform !== 'win32') return ''
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyEnable',
    ], { encoding: 'utf-8', windowsHide: true })
    if (!/\bProxyEnable\b[\s\S]*0x1\b/i.test(output)) return ''
  } catch {
    return ''
  }

  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer',
    ], { encoding: 'utf-8', windowsHide: true })
    const match = output.match(/\bProxyServer\b\s+REG_SZ\s+(.+)\s*$/im)
    return normalizeWindowsProxyServer(match?.[1] || '')
  } catch {
    return ''
  }
}

export function normalizeWindowsProxyServer(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const parts = value.includes(';')
    ? Object.fromEntries(value.split(';').map(part => {
      const [key, ...rest] = part.split('=')
      return [key.trim().toLowerCase(), rest.join('=').trim()]
    }).filter(([key, val]) => key && val))
    : {}
  const target = parts.https || parts.http || value
  if (!target) return ''
  return /^https?:\/\//i.test(target) ? target : `http://${target}`
}

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

function enabledValue(value: unknown): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return true
  return boolValue(value)
}

function singleLine(value: unknown): string {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed || undefined
}

function classifyScaleconnectStderr(stderr: string | undefined): { reason: string; verificationUrl?: string } | null {
  if (!stderr || !/load data error/i.test(stderr)) return null
  const notification = stderr.match(/notification=(https?:\/\/\S+)/)
  if (notification?.[1]) {
    return { reason: 'xiaomi_identity_verification_required', verificationUrl: notification[1] }
  }
  return { reason: 'scaleconnect_load_data_failed' }
}

function skipped(reason: string, settings: ScaleSyncSettings): ScaleSyncResult {
  return {
    status: 'skipped',
    reason,
    command: settings.scaleconnectPath ? `${settings.scaleconnectPath} -c <redacted-json>` : undefined,
    importedCount: 0,
    readings: [],
  }
}
