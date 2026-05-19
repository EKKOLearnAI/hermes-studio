import { createReadStream, existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { SessionDeleter } from '../../services/hermes/session-deleter'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { logger } from '../../services/logger'
import { smartCloneCleanup } from '../../services/hermes/profile-credentials'
import { detectHermesRootHome } from '../../services/hermes/hermes-path'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import type { HermesProfile } from '../../services/hermes/hermes-cli'

const RESERVED_PROFILE_NAMES = new Set([
  'hermes', 'default', 'test', 'tmp', 'root', 'sudo',
])

const HERMES_SUBCOMMAND_PROFILE_NAMES = new Set([
  'chat', 'model', 'gateway', 'setup', 'whatsapp', 'login', 'logout',
  'status', 'cron', 'doctor', 'dump', 'config', 'pairing', 'skills', 'tools',
  'mcp', 'sessions', 'insights', 'version', 'update', 'uninstall',
  'profile', 'plugins', 'honcho', 'acp',
])

function normalizeProfileName(name: string): string {
  return String(name || '').trim().toLowerCase()
}

function isForbiddenProfileName(name: string): boolean {
  const normalized = normalizeProfileName(name)
  if (!normalized || normalized === 'default') return false
  return RESERVED_PROFILE_NAMES.has(normalized) || HERMES_SUBCOMMAND_PROFILE_NAMES.has(normalized)
}

function getActiveProfileFile(): string {
  return join(detectHermesRootHome(), 'active_profile')
}

function listProfilesFromDisk(activeProfileName: string): HermesProfile[] {
  const base = detectHermesRootHome()
  const profiles: HermesProfile[] = [{
    name: 'default',
    active: activeProfileName === 'default',
    model: '—',
    gateway: 'stopped',
    alias: '',
  }]
  const profilesDir = join(base, 'profiles')
  if (!existsSync(profilesDir)) return profiles
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const dir = join(profilesDir, name)
    if (!existsSync(join(dir, 'config.yaml')) && !existsSync(dir)) continue
    profiles.push({
      name,
      active: name === activeProfileName,
      model: '—',
      gateway: 'stopped',
      alias: '',
    })
  }
  return profiles
}

function profileExistsForManualSwitch(name: string): boolean {
  const base = detectHermesRootHome()
  if (!name || name === 'default') return true
  return existsSync(join(base, 'profiles', name, 'config.yaml')) || existsSync(join(base, 'profiles', name))
}

function deleteForbiddenProfileFromDisk(name: string): boolean {
  if (!isForbiddenProfileName(name)) return false
  const base = detectHermesRootHome()
  const profileDir = join(base, 'profiles', name)
  if (!existsSync(profileDir)) return false
  rmSync(profileDir, { recursive: true, force: true })
  try {
    if (normalizeProfileName(getActiveProfileName()) === normalizeProfileName(name)) {
      writeFileSync(getActiveProfileFile(), 'default\n', 'utf-8')
    }
  } catch {}
  logger.warn('[deleteProfile] removed reserved profile "%s" from disk after Hermes CLI rejected deletion', name)
  return true
}

async function useProfileWithFallback(name: string): Promise<string> {
  if (isForbiddenProfileName(name)) {
    throw new Error(`Profile name '${name}' is reserved and cannot be activated`)
  }
  try {
    return await hermesCli.useProfile(name)
  } catch (err: any) {
    if (!profileExistsForManualSwitch(name)) throw err

    const base = detectHermesRootHome()
    writeFileSync(join(base, 'active_profile'), `${name}\n`, 'utf-8')
    logger.warn(err, '[switchProfile] hermes profile use failed; wrote active_profile directly for existing profile "%s"', name)
    return `Switched to profile ${name}`
  }
}

export async function list(ctx: any) {
  try {
    let profiles: HermesProfile[]
    try {
      profiles = await hermesCli.listProfiles()
    } catch (err: any) {
      const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
      const activeProfileName = getActiveProfileName()
      if (!isForbiddenProfileName(activeProfileName)) throw err

      logger.warn(err, '[listProfiles] active_profile "%s" is invalid/reserved; resetting to default and listing profiles from disk', activeProfileName)
      writeFileSync(getActiveProfileFile(), 'default\n', 'utf-8')
      profiles = listProfilesFromDisk('default')
    }

    // Override active flag from the authoritative source (active_profile file)
    // CLI output may be stale, but the file is written by hermes profile use
    const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
    const activeProfileName = getActiveProfileName()

    // Check if CLI's active flag matches the file (warn if inconsistent)
    const cliActive = profiles.find(p => p.active)
    if (cliActive?.name !== activeProfileName) {
      logger.warn('[listProfiles] CLI active flag (%s) differs from active_profile file (%s) - using file as authoritative source',
        cliActive?.name || 'none', activeProfileName)
    }

    // Fix the active flag based on the actual active_profile file
    profiles.forEach(p => {
      p.active = (p.name === activeProfileName)
    })

    ctx.body = { profiles }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function create(ctx: any) {
  const { name, clone } = ctx.request.body as { name?: string; clone?: boolean }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved and cannot be created` }
    return
  }
  try {
    const output = await hermesCli.createProfile(name, clone)

    // clone=true 时执行智能清理：
    //   - 删除 .env 中的独占平台凭据（Weixin / Telegram / Slack / ...）
    //   - 禁用 config.yaml 中对应的平台节点
    // 避免新 profile 与源 profile 共享同一个 bot token 导致互斥冲突。
    let strippedCredentials: string[] = []
    let disabledPlatforms: string[] = []
    let strippedConfigCredentials: string[] = []
    if (clone) {
      try {
        const cleanup = smartCloneCleanup(name)
        strippedCredentials = cleanup.strippedCredentials
        disabledPlatforms = cleanup.disabledPlatforms
        strippedConfigCredentials = cleanup.strippedConfigCredentials
        if (
          strippedCredentials.length > 0 ||
          disabledPlatforms.length > 0 ||
          strippedConfigCredentials.length > 0
        ) {
          logger.info(
            'Smart clone cleanup for "%s": stripped %d env credentials (%s), disabled %d platforms (%s), stripped %d config credentials (%s)',
            name,
            strippedCredentials.length, strippedCredentials.join(','),
            disabledPlatforms.length, disabledPlatforms.join(','),
            strippedConfigCredentials.length, strippedConfigCredentials.join(','),
          )
        }
      } catch (err: any) {
        // 清理失败不应阻断 profile 创建，仅记日志
        logger.error(err, 'Smart clone cleanup failed for "%s"', name)
      }
    }

    const mgr = getGatewayManagerInstance()
    if (mgr) {
      try { await mgr.start(name) } catch (err: any) {
        logger.error(err, 'Failed to start gateway for profile "%s"', name)
      }
    }
    ctx.body = {
      success: true,
      message: output.trim(),
      strippedCredentials,
      disabledPlatforms,
      strippedConfigCredentials,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: any) {
  try {
    const profile = await hermesCli.getProfile(ctx.params.name)
    ctx.body = { profile }
  } catch (err: any) {
    ctx.status = err.message.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const { name } = ctx.params
  if (name === 'default') {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete the default profile' }
    return
  }
  try {
    const mgr = getGatewayManagerInstance()
    if (mgr) { try { await mgr.stop(name) } catch { } }
    const ok = await hermesCli.deleteProfile(name)
    if (ok) {
      ctx.body = { success: true }
    } else if (deleteForbiddenProfileFromDisk(name)) {
      ctx.body = { success: true, fallback: 'removed_reserved_profile_from_disk' }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function rename(ctx: any) {
  const { new_name } = ctx.request.body as { new_name?: string }
  if (!new_name) {
    ctx.status = 400
    ctx.body = { error: 'Missing new_name' }
    return
  }
  try {
    const ok = await hermesCli.renameProfile(ctx.params.name, new_name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function switchProfile(ctx: any) {
  const { name } = ctx.request.body as { name?: string }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  if (isForbiddenProfileName(name)) {
    ctx.status = 400
    ctx.body = { error: `Profile name '${name}' is reserved and cannot be activated` }
    return
  }
  try {
    const output = await useProfileWithFallback(name)

    // Verify the active_profile file immediately (Hermes CLI writes synchronously)
    // Quick verification with 2 retries to handle edge cases (filesystem delays, concurrency)
    const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
    let actualActive = getActiveProfileName()

    // Quick retry (max 2 times, 100ms delay each)
    for (let i = 0; i < 2; i++) {
      if (actualActive === name) break
      logger.debug('[switchProfile] Quick retry %d: current=%s, expected=%s', i + 1, actualActive, name)
      await new Promise(r => setTimeout(r, 100))
      actualActive = getActiveProfileName()
    }

    if (actualActive !== name) {
      logger.error('[switchProfile] Verification failed: active_profile is %s (expected %s)', actualActive, name)
      ctx.status = 500
      ctx.body = { error: `Profile switch verification failed - active profile is ${actualActive}` }
      return
    }

    // Update GatewayManager to match the authoritative source
    const mgr = getGatewayManagerInstance()
    if (mgr) { mgr.setActiveProfile(name) }

    // Destroy all bridge sessions so they get recreated with the new profile config
    try {
      const { AgentBridgeClient } = await import('../../services/hermes/agent-bridge')
      const bridge = new AgentBridgeClient()
      await bridge.destroyAll()
      logger.info('[switchProfile] destroyed all bridge sessions for profile "%s"', name)
    } catch (err: any) {
      logger.warn(err, '[switchProfile] failed to destroy bridge sessions')
    }

    try {
      const detail = await hermesCli.getProfile(name)
      logger.debug('Profile detail.path = %s', detail.path)

      // 确保配置文件存在，但不调用 setupReset()（会重置端口配置）
      const profileConfig = join(detail.path, 'config.yaml')
      if (!existsSync(profileConfig)) {
        writeFileSync(profileConfig, '# Hermes Agent Configuration\n', 'utf-8')
        logger.info('Created config.yaml for: %s', detail.path)
      }

      const profileEnv = join(detail.path, '.env')
      if (!existsSync(profileEnv)) {
        writeFileSync(profileEnv, '# Hermes Agent Environment Configuration\n', 'utf-8')
        logger.info('Created .env for: %s', detail.path)
      }
    } catch (err: any) {
      logger.error(err, 'Ensure config failed')
    }

    // TODO: re-enable pending session delete drain after confirming safety
    // const drainResult = await SessionDeleter.getInstance().drain(name)
    SessionDeleter.getInstance().switchProfile(name)
    logger.info('[switchProfile] switched session deleter to profile "%s"', name)
    // if (drainResult.failed.length > 0) {
    //   logger.warn({ profile: name, failed: drainResult.failed }, 'Failed to drain some pending session deletes after profile switch')
    // }

    ctx.body = {
      success: true,
      message: output.trim(),
      // drained_session_deletes: drainResult.deleted.length,
      // failed_session_deletes: drainResult.failed.length,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function exportProfile(ctx: any) {
  const { name } = ctx.params
  const outputPath = join(tmpdir(), `hermes-profile-${name}.tar.gz`)
  try {
    await hermesCli.exportProfile(name, outputPath)
    if (!existsSync(outputPath)) {
      ctx.status = 500
      ctx.body = { error: 'Export file not found' }
      return
    }
    const filename = basename(outputPath)
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Type', 'application/gzip')
    ctx.body = createReadStream(outputPath)
    ctx.res.on('finish', () => { try { unlinkSync(outputPath) } catch { } })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function importProfile(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }
  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }
  const tmpDir = join(tmpdir(), 'hermes-import')
  await mkdir(tmpDir, { recursive: true })
  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('latin1')
  const parts = body.split(boundary).slice(1, -1)
  let archivePath = ''
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const header = part.substring(0, headerEnd)
    const data = part.substring(headerEnd + 4, part.length - 2)
    const filenameMatch = header.match(/filename="([^"]+)"/)
    if (!filenameMatch) continue
    const filename = filenameMatch[1]
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    if (!['.gz', '.tar.gz', '.zip', '.tgz'].includes(ext)) continue
    archivePath = join(tmpDir, filename)
    await writeFile(archivePath, Buffer.from(data, 'binary'))
    break
  }
  if (!archivePath) {
    ctx.status = 400
    ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)' }
    return
  }
  try {
    const result = await hermesCli.importProfile(archivePath)
    try { unlinkSync(archivePath) } catch { }
    ctx.body = { success: true, message: result.trim() }
  } catch (err: any) {
    try { unlinkSync(archivePath) } catch { }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
