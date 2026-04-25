import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

const execOpts = { windowsHide: true }
const isDocker = existsSync('/.dockerenv')

function resolveHermesBin(): string {
  const envBin = process.env.HERMES_BIN?.trim()
  if (envBin) return envBin
  return 'hermes'
}

const HERMES_BIN = resolveHermesBin()

export interface HermesSession {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  messages?: any[]
}

export interface HermesSessionFull {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd?: number | null
  cost_status?: string
  messages?: any[]
  system_prompt?: string
  model_config?: string
  cost_source?: string
  pricing_version?: string | null
  [key: string]: any
}

function parseSessionExport(stdout: string): HermesSessionFull[] {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const sessions: HermesSessionFull[] = []
  for (const line of lines) {
    try {
      const raw: HermesSessionFull = JSON.parse(line)
      sessions.push(raw)
    } catch {
      // Skip non-JSON lines such as "Session 'x' not found."
    }
  }
  return sessions
}

export async function exportSessionsRaw(source?: string): Promise<HermesSessionFull[]> {
  const args = ['sessions', 'export', '-']
  if (source) args.push('--source', source)

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 30000,
      ...execOpts,
    })
    return parseSessionExport(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: sessions export failed')
    throw new Error(`Failed to list sessions: ${err.message}`)
  }
}

/**
 * List sessions from Hermes CLI (without messages)
 */
export async function listSessions(source?: string, limit?: number): Promise<HermesSession[]> {
  const raws = await exportSessionsRaw(source)
  const sessions: HermesSession[] = []

  for (const raw of raws) {
    let title = raw.title
    if (!title && raw.messages) {
      const firstUser = raw.messages.find((m: any) => m.role === 'user')
      if (firstUser?.content) {
        const t = String(firstUser.content).slice(0, 40)
        title = t + (String(firstUser.content).length > 40 ? '...' : '')
      }
    }
    sessions.push({
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
    })
  }

  // Sort by started_at descending
  sessions.sort((a, b) => b.started_at - a.started_at)

  if (limit && limit > 0) {
    return sessions.slice(0, limit)
  }
  return sessions
}

/**
 * Get a single session with messages from Hermes CLI
 */
export async function getSession(id: string): Promise<HermesSession | null> {
  const args = ['sessions', 'export', '-', '--session-id', id]

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })

    const raws = parseSessionExport(stdout)
    if (raws.length === 0) return null

    const raw: HermesSessionFull = raws[0]
    return {
      id: raw.id,
      source: raw.source,
      user_id: raw.user_id,
      model: raw.model,
      title: raw.title,
      started_at: raw.started_at,
      ended_at: raw.ended_at,
      end_reason: raw.end_reason,
      message_count: raw.message_count,
      tool_call_count: raw.tool_call_count,
      input_tokens: raw.input_tokens,
      output_tokens: raw.output_tokens,
      cache_read_tokens: raw.cache_read_tokens || 0,
      cache_write_tokens: raw.cache_write_tokens || 0,
      reasoning_tokens: raw.reasoning_tokens || 0,
      billing_provider: raw.billing_provider,
      estimated_cost_usd: raw.estimated_cost_usd,
      actual_cost_usd: raw.actual_cost_usd ?? null,
      cost_status: raw.cost_status || '',
      messages: raw.messages,
    }
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: session export failed')
    throw new Error(`Failed to get session: ${err.message}`)
  }
}

/**
 * Delete a session from Hermes CLI
 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await execFileAsync(HERMES_BIN, ['sessions', 'delete', id, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session delete failed')
    return false
  }
}

/**
 * Rename a session title via Hermes CLI
 */
export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await execFileAsync(HERMES_BIN, ['sessions', 'rename', id, title], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: session rename failed')
    return false
  }
}

export interface LogFileInfo {
  name: string
  size: string
  modified: string
}

/**
 * Get Hermes version
 */
export async function getVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['--version'], { timeout: 5000, ...execOpts })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Start Hermes gateway (uses launchd/systemd)
 */
export async function startGateway(): Promise<string> {
  if (isDocker) {
    const pid = await startGatewayBackground()
    return pid ? `Gateway started (PID: ${pid})` : 'Gateway start triggered'
  }

  const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['gateway', 'start'], {
    timeout: 30000,
    ...execOpts,
  })
  return stdout || stderr
}

/**
 * Start Hermes gateway in background (for WSL where launchd/systemd is unavailable)
 * Uses "hermes gateway run" as a detached background process
 */
export async function startGatewayBackground(): Promise<number | null> {
  const child = spawn(HERMES_BIN, ['gateway', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child.pid ?? null
}

/**
 * Restart Hermes gateway
 */
export async function restartGateway(): Promise<string> {
  if (isDocker) {
    try { await stopGateway() } catch { }
    const pid = await startGatewayBackground()
    return pid ? `Gateway restarted (PID: ${pid})` : 'Gateway restart triggered'
  }

  const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['gateway', 'restart'], {
    timeout: 30000,
    ...execOpts,
  })
  return stdout || stderr
}

/**
 * Stop Hermes gateway
 */
export async function stopGateway(): Promise<string> {
  const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['gateway', 'stop'], {
    timeout: 30000,
    ...execOpts,
  })
  return stdout || stderr
}

/**
 * List available log files
 */
export async function listLogFiles(): Promise<LogFileInfo[]> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['logs', 'list'], {
      timeout: 10000,
      ...execOpts,
    })
    const files: LogFileInfo[] = []
    const lines = stdout.trim().split('\n').filter(l => l.includes('.log'))
    for (const line of lines) {
      const match = line.match(/^\s+(\S+)\s+([\d.]+\w+)\s+(.+)$/)
      if (match) {
        const rawName = match[1]
        const name = rawName.replace(/\.log$/, '')
        if (['agent', 'errors', 'gateway'].includes(name)) {
          files.push({ name, size: match[2], modified: match[3].trim() })
        }
      }
    }
    return files
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: logs list failed')
    return []
  }
}

/**
 * Read log lines
 */
export async function readLogs(
  logName: string = 'agent',
  lines: number = 100,
  level?: string,
  session?: string,
  since?: string,
): Promise<string> {
  const args = ['logs', logName, '-n', String(lines)]
  if (level) args.push('--level', level)
  if (session) args.push('--session', session)
  if (since) args.push('--since', since)

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
      ...execOpts,
    })
    return stdout
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: logs read failed')
    throw new Error(`Failed to read logs: ${err.message}`)
  }
}

// ─── Profile management ──────────────────────────────────────

export interface HermesProfile {
  name: string
  active: boolean
  model: string
  gateway: string
  alias: string
  backend_url?: string
  backend_token?: string
  bff_url?: string
  bff_token?: string
}

export interface HermesProfileDetail {
  name: string
  path: string
  model: string
  provider: string
  gateway: string
  skills: number
  hasEnv: boolean
  hasSoulMd: boolean
}

/**
 * List all profiles
 */
export async function listProfiles(): Promise<HermesProfile[]> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['profile', 'list'], {
      timeout: 10000,
      ...execOpts,
    })

    const lines = stdout.trim().split('\n').filter(Boolean)
    const profiles: HermesProfile[] = []
    const hermesBase = join(homedir(), '.hermes')

    // Skip header lines (starts with " Profile" or " ─")
    for (const line of lines) {
      if (line.startsWith(' Profile') || line.match(/^ ─/)) continue

      const match = line.match(/^\s+(◆)?(\S+)\s{2,}(\S+)\s{2,}(\S+)\s{2,}(.*)$/)
      if (match) {
        const name = match[2]
        const profile: HermesProfile = {
          name,
          active: !!match[1],
          model: match[3],
          gateway: match[4],
          alias: match[5].trim() === '—' ? '' : match[5].trim(),
        }

        // Read backend config from profile's config.yaml
        const configPath = name === 'default'
          ? join(hermesBase, 'config.yaml')
          : join(hermesBase, 'profiles', name, 'config.yaml')
        if (existsSync(configPath)) {
          try {
            const content = readFileSync(configPath, 'utf-8')
            const urlMatch = content.match(/(?:^|\n)\s+url:\s*(.+)$/m)
            const tokenMatch = content.match(/(?:^|\n)\s+token:\s*(.+)$/m)
            const bffUrlMatch = content.match(/(?:^|\n)\s+bff_url:\s*(.+)$/m)
            const bffTokenMatch = content.match(/(?:^|\n)\s+bff_token:\s*(.+)$/m)
            if (urlMatch) profile.backend_url = urlMatch[1].trim()
            if (tokenMatch) profile.backend_token = tokenMatch[1].trim()
            if (bffUrlMatch) profile.bff_url = bffUrlMatch[1].trim()
            if (bffTokenMatch) profile.bff_token = bffTokenMatch[1].trim()
          } catch { /* ignore parse errors */ }
        }

        profiles.push(profile)
      }
    }

    return profiles
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile list failed')
    throw new Error(`Failed to list profiles: ${err.message}`)
  }
}

/**
 * Get profile details
 */
export async function getProfile(name: string): Promise<HermesProfileDetail> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['profile', 'show', name], {
      timeout: 10000,
      ...execOpts,
    })

    const result: Record<string, string> = {}
    for (const line of stdout.trim().split('\n')) {
      const match = line.match(/^(\w[\w\s]*?):\s+(.+)$/)
      if (match) {
        result[match[1].trim().toLowerCase().replace(/\s+/g, '_')] = match[2].trim()
      }
    }

    const modelFull = result.model || ''
    const providerMatch = modelFull.match(/\((.+)\)/)
    const model = providerMatch ? modelFull.replace(/\s*\(.+\)/, '').trim() : modelFull

    return {
      name: result.profile || name,
      path: result.path || '',
      model,
      provider: providerMatch ? providerMatch[1] : '',
      gateway: result.gateway || '',
      skills: parseInt(result.skills || '0', 10),
      hasEnv: result['.env'] === 'exists',
      hasSoulMd: result.soul_md === 'exists',
    }
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) {
      throw new Error(`Profile "${name}" not found`)
    }
    logger.error(err, 'Hermes CLI: profile show failed')
    throw new Error(`Failed to get profile: ${err.message}`)
  }
}

/**
 * Create a new profile
 */
export async function createProfile(name: string, clone?: boolean): Promise<string> {
  const args = ['profile', 'create', name]
  if (clone) args.push('--clone')

  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
      timeout: 15000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile create failed')
    throw new Error(`Failed to create profile: ${err.message}`)
  }
}

/**
 * Delete a profile
 */
export async function deleteProfile(name: string): Promise<boolean> {
  try {
    await execFileAsync(HERMES_BIN, ['profile', 'delete', name, '--yes'], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile delete failed')
    return false
  }
}

/**
 * Rename a profile
 */
export async function renameProfile(oldName: string, newName: string): Promise<boolean> {
  try {
    await execFileAsync(HERMES_BIN, ['profile', 'rename', oldName, newName], {
      timeout: 10000,
      ...execOpts,
    })
    return true
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile rename failed')
    return false
  }
}

/**
 * Switch active profile
 */
export async function useProfile(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['profile', 'use', name], {
      timeout: 10000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile use failed')
    throw new Error(`Failed to switch profile: ${err.message}`)
  }
}

/**
 * Export profile to archive
 */
export async function exportProfile(name: string, outputPath?: string): Promise<string> {
  const args = ['profile', 'export', name]
  if (outputPath) args.push('--output', outputPath)

  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
      timeout: 60000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile export failed')
    throw new Error(`Failed to export profile: ${err.message}`)
  }
}

/**
 * Run hermes setup --non-interactive --reset to generate default config for current profile
 */
export async function setupReset(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, ['setup', '--non-interactive', '--reset'], {
      timeout: 30000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: setup reset failed')
    throw new Error(`Failed to reset config: ${err.message}`)
  }
}

/**
 * Import profile from archive
 */
export async function importProfile(archivePath: string, name?: string): Promise<string> {
  const args = ['profile', 'import', archivePath]
  if (name) args.push('--name', name)

  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
      timeout: 60000,
      ...execOpts,
    })
    return stdout || stderr
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: profile import failed')
    throw new Error(`Failed to import profile: ${err.message}`)
  }
}
