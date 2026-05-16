import { readFile } from 'fs/promises'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { getActiveConfigPath, getActiveEnvPath } from '../../services/hermes/hermes-profile'
import { saveEnvValue } from '../../services/config-helpers'
import { logger } from '../../services/logger'
import { safeFileStore } from '../../services/safe-file-store'

const PLATFORM_SECTIONS = new Set([
  'telegram', 'discord', 'slack', 'whatsapp', 'matrix',
  'weixin', 'wecom', 'feishu', 'dingtalk', 'qqbot',
  'approvals',
])

const configPath = () => getActiveConfigPath()
const envPath = () => getActiveEnvPath()

const envPlatformMap: Record<string, [string, string]> = {
  TELEGRAM_BOT_TOKEN: ['telegram', 'token'],
  DISCORD_BOT_TOKEN: ['discord', 'token'],
  SLACK_BOT_TOKEN: ['slack', 'token'],
  MATRIX_ACCESS_TOKEN: ['matrix', 'token'],
  MATRIX_HOMESERVER: ['matrix', 'extra.homeserver'],
  FEISHU_APP_ID: ['feishu', 'extra.app_id'],
  FEISHU_APP_SECRET: ['feishu', 'extra.app_secret'],
  DINGTALK_CLIENT_ID: ['dingtalk', 'extra.client_id'],
  DINGTALK_CLIENT_SECRET: ['dingtalk', 'extra.client_secret'],
  DINGTALK_APP_KEY: ['dingtalk', 'extra.app_key'],
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

async function readEnvPlatforms(): Promise<Record<string, any>> {
  try {
    const raw = await readFile(envPath(), 'utf-8')
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

async function readConfig(): Promise<Record<string, any>> {
  return safeFileStore.readYaml(configPath())
}

export async function getConfig(ctx: any) {
  try {
    const config = await readConfig()
    const envPlatforms = await readEnvPlatforms()
    if (Object.keys(envPlatforms).length > 0) {
      const existing = config.platforms || {}
      for (const [platform, vals] of Object.entries(envPlatforms)) {
        existing[platform] = deepMerge(existing[platform] || {}, vals as Record<string, any>)
      }
      config.platforms = existing
    }
    const { section, sections } = ctx.query
    if (section) {
      ctx.body = { [section as string]: config[section as string] || {} }
    } else if (sections) {
      const keys = (sections as string).split(',')
      const result: Record<string, any> = {}
      for (const key of keys) { result[key.trim()] = config[key.trim()] || {} }
      ctx.body = result
    } else {
      ctx.body = config
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function updateConfig(ctx: any) {
  const { section, values } = ctx.request.body as { section: string; values: Record<string, any> }
  if (!section || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing section or values' }; return
  }
  try {
    await safeFileStore.updateYaml(configPath(), (config) => {
      config[section] = deepMerge(config[section] || {}, values)
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })

    // 使用 GatewayManager 重启平台网关
    if (PLATFORM_SECTIONS.has(section)) {
      const mgr = getGatewayManagerInstance()
      if (mgr) {
        try {
          const activeProfile = mgr.getActiveProfile()
          await mgr.stop(activeProfile)
          await mgr.start(activeProfile)
        } catch (err) {
          logger.error(err, 'GatewayManager restart failed')
        }
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function updateCredentials(ctx: any) {
  const { platform, values } = ctx.request.body as { platform: string; values: Record<string, any> }
  if (!platform || !values) {
    ctx.status = 400; ctx.body = { error: 'Missing platform or values' }; return
  }
  try {
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
    await safeFileStore.updateYaml(configPath(), async (config) => {
      for (const [cfgPath, val] of Object.entries(flatValues)) {
        const envVar = envMap[cfgPath]
        if (!envVar) continue
        if (val === undefined || val === null || val === '') {
          await saveEnvValue(envVar, '')
          const parts = cfgPath.split('.')
          let obj: any = config.platforms?.[platform]
          if (obj) {
            if (parts.length === 1) { delete obj[parts[0]] }
            else {
              let cur = obj
              for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]]) break; cur = cur[parts[i]] }
              delete cur[parts[parts.length - 1]]
              if (obj.extra && Object.keys(obj.extra).length === 0) delete obj.extra
            }
            if (Object.keys(obj).length === 0) { if (!config.platforms) config.platforms = {}; delete config.platforms[platform] }
          }
        } else {
          await saveEnvValue(envVar, String(val))
        }
      }
      return config
    }, {
      backup: true,
      dumpOptions: {
        forceQuotes: true,
      },
    })

    // 使用 GatewayManager 重启平台网关
    const mgr = getGatewayManagerInstance()
    if (mgr) {
      try {
        const activeProfile = mgr.getActiveProfile()
        await mgr.stop(activeProfile)
        await mgr.start(activeProfile)
      } catch (err) {
        logger.error(err, 'GatewayManager restart failed')
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
