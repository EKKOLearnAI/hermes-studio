import { readFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { restartGatewayForProfile } from '../../services/hermes/gateway-autostart'
import { readAppConfig, writeAppConfig, normalizeGatewayAutoStartConfig } from '../../services/app-config'
import { saveEnvValueForProfile } from '../../services/config-helpers'
import { logger } from '../../services/logger'
import { safeFileStore } from '../../services/safe-file-store'
import { EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS } from '../../services/hermes/profile-credentials'

const PLATFORM_SECTIONS = new Set([
  'telegram', 'discord', 'slack', 'whatsapp', 'matrix',
  'weixin', 'wecom', 'feishu', 'dingtalk', 'qqbot',
  'approvals',
])

const APP_CONFIG_SECTIONS = new Set(['gatewayAutoStart'])

function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

const configPath = (profile: string) => join(getProfileDir(profile), 'config.yaml')
const envPath = (profile: string) => join(getProfileDir(profile), '.env')

const envPlatformMap: Record<string, [string, string]> = {
  TELEGRAM_BOT_TOKEN: ['telegram', 'token'],
  DISCORD_BOT_TOKEN: ['discord', 'token'],
  SLACK_BOT_TOKEN: ['slack', 'token'],
  MATRIX_ACCESS_TOKEN: ['matrix', 'token'],
  MATRIX_HOMESERVER: ['matrix', 'extra.homeserver'],
  FEISHU_APP_ID: ['feishu', 'extra.app_id'],
  FEISHU_APP_SECRET: ['feishu', 'extra.app_secret'],
  FEISHU_ENCRYPT_KEY: ['feishu', 'extra.encrypt_key'],
  FEISHU_VERIFICATION_TOKEN: ['feishu', 'extra.verification_token'],
  DINGTALK_CLIENT_ID: ['dingtalk', 'extra.client_id'],
  DINGTALK_CLIENT_SECRET: ['dingtalk', 'extra.client_secret'],
  DINGTALK_APP_KEY: ['dingtalk', 'extra.app_key'],
  DINGTALK_CARD_TEMPLATE_ID: ['dingtalk', 'extra.card_template_id'],
  DINGTALK_ALLOWED_USERS: ['dingtalk', 'allowed_users'],
  DINGTALK_ALLOW_ALL_USERS: ['dingtalk', 'allow_all_users'],
  QQ_APP_ID: ['qqbot', 'extra.app_id'],
  QQ_CLIENT_SECRET: ['qqbot', 'extra.client_secret'],
  QQ_ALLOWED_USERS: ['qqbot', 'allowed_users'],
  QQ_ALLOW_ALL_USERS: ['qqbot', 'allow_all_users'],
  WECOM_BOT_ID: ['wecom', 'extra.bot_id'],
  WECOM_SECRET: ['wecom', 'extra.secret'],
  WEIXIN_TOKEN: ['weixin', 'token'],
  WEIXIN_ACCOUNT_ID: ['weixin', 'extra.account_id'],
  WEIXIN_BASE_URL: ['weixin', 'extra.base_url'],
  WHATSAPP_ENABLED: ['whatsapp', 'enabled'],
}

const platformEnvMap: Record<string, Record<string, string>> = {}
for (const [envVar, [platform, cfgPath]] of Object.entries(envPlatformMap)) {
  if (!platformEnvMap[platform]) platformEnvMap[platform] = {}
  platformEnvMap[platform][cfgPath] = envVar
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (val) env[key] = val
  }
  return env
}

function setNested(obj: Record<string, any>, path: string, value: any) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) cur[parts[i]] = {}; cur = cur[parts[i]] }
  cur[parts[parts.length - 1]] = value
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      target[key] = deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
  return target
}

const AUXILIARY_TASKS = [
  { key: 'vision', label: 'Vision', default_timeout: 120, default_download_timeout: 30 },
  { key: 'web_extract', label: 'Web extract', default_timeout: 360 },
  { key: 'compression', label: 'Compression', default_timeout: 120 },
  { key: 'skills_hub', label: 'Skills hub', default_timeout: 30 },
  { key: 'approval', label: 'Approval', default_timeout: 30 },
  { key: 'mcp', label: 'MCP', default_timeout: 30 },
  { key: 'title_generation', label: 'Title generation', default_timeout: 30 },
  { key: 'triage_specifier', label: 'Triage specifier', default_timeout: 120 },
  { key: 'kanban_decomposer', label: 'Kanban decomposer', default_timeout: 180 },
  { key: 'profile_describer', label: 'Profile describer', default_timeout: 60 },
  { key: 'curator', label: 'Curator', default_timeout: 600 },
  { key: 'session_search', label: 'Session search', default_timeout: 30 },
  { key: 'flush_memories', label: 'Flush memories', default_timeout: 30 },
] as const

const AUX_STRING_FIELDS = new Set(['provider', 'model', 'base_url', 'api_key'])
const AUX_NUMBER_FIELDS = new Set(['timeout', 'download_timeout'])

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSafeAuxiliaryKey(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value) &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor'
}

function normalizeAuxiliaryConfig(value: unknown, options: { resetAuto?: boolean } = {}): Record<string, any> {
  if (!isPlainRecord(value)) return {}
  const normalized: Record<string, any> = {}

  for (const [task, rawSettings] of Object.entries(value)) {
    if (!isSafeAuxiliaryKey(task) || !isPlainRecord(rawSettings)) continue
    const settings: Record<string, any> = {}
    const provider = typeof rawSettings.provider === 'string' ? rawSettings.provider.trim() : ''
    const resetToAuto = options.resetAuto === true && provider === 'auto'

    for (const [field, rawValue] of Object.entries(rawSettings)) {
      if (resetToAuto && field !== 'provider' && field !== 'timeout' && field !== 'download_timeout') continue
      if (AUX_STRING_FIELDS.has(field)) {
        if (typeof rawValue !== 'string') continue
        const trimmed = rawValue.trim()
        if (trimmed) settings[field] = trimmed
      } else if (AUX_NUMBER_FIELDS.has(field)) {
        if (field === 'download_timeout' && task !== 'vision') continue
        if (rawValue === null || rawValue === undefined || rawValue === '') continue
        const numberValue = Number(rawValue)
        if (Number.isFinite(numberValue) && numberValue > 0) {
          settings[field] = Math.floor(numberValue)
        }
      } else if (field === 'extra_body') {
        if (isPlainRecord(rawValue) && Object.keys(rawValue).length > 0) {
          settings.extra_body = rawValue
        }
      }
    }

    if (Object.keys(settings).length > 0) normalized[task] = settings
  }

  return normalized
}

async function readEnvPlatforms(profile: string): Promise<Record<string, any>> {
  try {
    const raw = await readFile(envPath(profile), 'utf-8')
    const env = parseEnv(raw)
    const platforms: Record<string, any> = {}
    for (const [envKey, [platform, cfgPath]] of Object.entries(envPlatformMap)) {
      const val = env[envKey]
      if (val === undefined || val === '') continue
      if (!platforms[platform]) platforms[platform] = {}
      let finalVal: any = val
      if (cfgPath === 'enabled' || cfgPath === 'allow_all_users') finalVal = val === 'true'
      setNested(platforms[platform], cfgPath, finalVal)
    }
    return platforms
  } catch { return {} }
}

async function readConfig(profile: string): Promise<Record<string, any>> {
  return safeFileStore.readYaml(configPath(profile))
}

export async function getConfig(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    const appConfig = await readAppConfig()
    const gatewayAutoStart = normalizeGatewayAutoStartConfig(appConfig.gatewayAutoStart)
    const envPlatforms = await readEnvPlatforms(profile)
    if (Object.keys(envPlatforms).length > 0) {
      const existing = config.platforms || {}
      for (const [platform, vals] of Object.entries(envPlatforms)) {
        existing[platform] = deepMerge(existing[platform] || {}, vals as Record<string, any>)
      }
      config.platforms = existing
    }
    const { section, sections } = ctx.query
    if (section) {
      const key = section as string
      if (key === 'gatewayAutoStart') {
        ctx.body = { gatewayAutoStart }
        return
      }
      ctx.body = { [key]: config[key] || {} }
    } else if (sections) {
      const keys = (sections as string).split(',')
      const result: Record<string, any> = {}
      for (const key of keys) {
        const trimmed = key.trim()
        result[trimmed] = trimmed === 'gatewayAutoStart' ? gatewayAutoStart : (config[trimmed] || {})
      }
      ctx.body = result
    } else {
      ctx.body = { ...config, gatewayAutoStart }
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function updateConfig(ctx: any) {
  const { section, values, restart } = ctx.request.body as { section: string; values: Record<string, any>; restart?: boolean }
  if (!section || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing section or values' }; return
  }
  try {
    if (APP_CONFIG_SECTIONS.has(section)) {
      if (section === 'gatewayAutoStart') {
        const appConfig = await readAppConfig()
        const next: Record<string, any> = { ...(appConfig.gatewayAutoStart || {}), ...values }
        if ('include' in values && !Array.isArray(values.include)) delete next.include
        if ('exclude' in values && !Array.isArray(values.exclude)) delete next.exclude
        if ('enabled' in values && typeof values.enabled !== 'boolean') delete next.enabled
        const gatewayAutoStart = normalizeGatewayAutoStartConfig(next)
        await writeAppConfig({ gatewayAutoStart })
        ctx.body = { success: true, gatewayAutoStart }
        return
      }
    }

    const profile = requestedProfile(ctx)
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      config[section] = deepMerge(config[section] || {}, values)
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })

    // Platform adapters run through Hermes gateway; restart it so channel
    // config changes (Feishu/Weixin/etc.) are applied.
    if (restart !== false && PLATFORM_SECTIONS.has(section)) {
      try {
        const restartResult = await restartGatewayForProfile(profile)
        logger.info('[config] gateway restarted after config update section=%s profile=%s result=%j', section, profile, restartResult)
      } catch (err) {
        logger.error(err, 'Gateway restart failed')
        ctx.status = 500
        ctx.body = { error: err instanceof Error ? err.message : 'Gateway restart failed' }
        return
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function getAuxiliaryModels(ctx: any) {
  try {
    const profile = requestedProfile(ctx)
    const config = await readConfig(profile)
    ctx.body = {
      tasks: AUXILIARY_TASKS,
      auxiliary: normalizeAuxiliaryConfig(config.auxiliary),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function updateAuxiliaryModels(ctx: any) {
  const body = ctx.request.body as { auxiliary?: unknown }
  if (!body || !isPlainRecord(body.auxiliary)) {
    ctx.status = 400
    ctx.body = { error: 'Missing auxiliary config' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    const auxiliary = normalizeAuxiliaryConfig(body.auxiliary, { resetAuto: true })
    await safeFileStore.updateYaml(configPath(profile), (config) => {
      if (Object.keys(auxiliary).length > 0) config.auxiliary = auxiliary
      else delete config.auxiliary
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })
    ctx.body = { success: true, auxiliary }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

function removeConfigPath(config: any, platform: string, cfgPath: string) {
  const parts = cfgPath.split('.')
  const obj: any = config.platforms?.[platform]
  if (!obj) return
  if (parts.length === 1) {
    delete obj[parts[0]]
  } else {
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur?.[parts[i]]) return
      cur = cur[parts[i]]
    }
    delete cur[parts[parts.length - 1]]
    if (obj.extra && Object.keys(obj.extra).length === 0) delete obj.extra
  }
  if (Object.keys(obj).length === 0) {
    if (!config.platforms) config.platforms = {}
    delete config.platforms[platform]
  }
}

function isSensitiveCredentialPath(cfgPath: string): boolean {
  const normalized = cfgPath.toLowerCase()
  const fieldName = normalized.split('.').pop() || normalized
  return EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS.includes(fieldName) ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('key') ||
    normalized.includes('password') ||
    normalized.includes('credential')
}

export async function updateCredentials(ctx: any) {
  const { platform, values } = ctx.request.body as { platform: string; values: Record<string, any> }
  if (!platform || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing platform or values' }; return
  }
  try {
    const profile = requestedProfile(ctx)
    const envMap = platformEnvMap[platform]
    if (!envMap) {
      ctx.status = 400; ctx.body = { error: `Unknown platform: ${platform}` }; return
    }
    const flatValues: Record<string, any> = {}
    for (const [key, val] of Object.entries(values)) {
      if (key === 'extra' && val && typeof val === 'object') {
        for (const [subKey, subVal] of Object.entries(val as Record<string, any>)) { flatValues[`extra.${subKey}`] = subVal }
      } else { flatValues[key] = val }
    }
    await safeFileStore.updateYaml(configPath(profile), async (config) => {
      for (const [cfgPath, val] of Object.entries(flatValues)) {
        const envVar = envMap[cfgPath]
        if (!envVar) continue
        if (val === undefined || val === null || val === '') {
          await saveEnvValueForProfile(profile, envVar, '')
          removeConfigPath(config, platform, cfgPath)
        } else {
          await saveEnvValueForProfile(profile, envVar, String(val))
          if (isSensitiveCredentialPath(cfgPath)) removeConfigPath(config, platform, cfgPath)
        }
      }
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })

    // Platform adapters run through Hermes gateway; restart it so channel
    // credentials are applied.
    try {
      const restartResult = await restartGatewayForProfile(profile)
      logger.info('[config] gateway restarted after credentials update platform=%s profile=%s result=%j', platform, profile, restartResult)
    } catch (err) {
      logger.error(err, 'Gateway restart failed')
      ctx.status = 500
      ctx.body = { error: err instanceof Error ? err.message : 'Gateway restart failed' }
      return
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
