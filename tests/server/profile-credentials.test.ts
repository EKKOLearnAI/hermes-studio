import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isExclusivePlatformKey,
  stripExclusivePlatformCredentials,
  disableExclusivePlatformsInConfig,
  copyModelProviderAuthForClone,
  EXCLUSIVE_PLATFORMS,
  EXCLUSIVE_PLATFORM_ENV_PATTERNS,
} from '../../packages/server/src/services/hermes/profile-credentials'

const originalHermesHome = process.env.HERMES_HOME
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'profile-cred-test-'))
})

afterEach(() => {
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('isExclusivePlatformKey', () => {
  it('matches all known exclusive platform prefixes (aligned with hermes-agent gateway/platforms)', () => {
    const samples = [
      'TELEGRAM_BOT_TOKEN',
      'DISCORD_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'SIGNAL_PHONE_NUMBER',
      'WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID',
      'FEISHU_APP_ID', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN',
    ]
    for (const k of samples) {
      expect(isExclusivePlatformKey(k)).toBe(true)
    }
  })

  it('does not match removed aliases or non-lock platforms', () => {
    // 这些前缀在 hermes-agent gateway/platforms/ 中没有 _acquire_platform_lock 调用
    const nonLock = [
      'WECHAT_APP_ID',         // wechat 不是上游 platform key（实际是 weixin）
      'LARK_APP_SECRET',       // lark 不是上游 platform key（实际是 feishu）
      'LINE_CHANNEL_SECRET',   // line 在 hermes-agent 中没有 adapter
      'MATTERMOST_TOKEN', 'MATRIX_TOKEN', 'DINGTALK_TOKEN',
      'WECOM_TOKEN', 'QQBOT_TOKEN', 'BLUEBUBBLES_TOKEN',
    ]
    for (const k of nonLock) {
      expect(isExclusivePlatformKey(k)).toBe(false)
    }
  })

  it('does not match model provider keys or generic config', () => {
    const safe = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'DEEPSEEK_API_KEY',
      'MINIMAX_API_KEY',
      'DASHSCOPE_API_KEY',
      'BROWSER_HEADLESS',
      'TERMINAL_DEFAULT_SHELL',
      'HERMES_MAX_ITERATIONS',
      'PORT',
      'NODE_ENV',
    ]
    for (const k of safe) {
      expect(isExclusivePlatformKey(k)).toBe(false)
    }
  })
})

describe('stripExclusivePlatformCredentials', () => {
  it('returns empty when file does not exist', () => {
    expect(stripExclusivePlatformCredentials(join(tmpDir, 'nope.env'))).toEqual([])
  })

  it('returns empty and does not write when no exclusive keys present', () => {
    const p = join(tmpDir, '.env')
    const content = 'OPENAI_API_KEY=sk-xxx\nPORT=8642\n'
    writeFileSync(p, content)
    expect(stripExclusivePlatformCredentials(p)).toEqual([])
    expect(readFileSync(p, 'utf-8')).toBe(content)
    // 无备份文件
    expect(readdirSync(tmpDir).filter(f => f.startsWith('.env.bak'))).toHaveLength(0)
  })

  it('strips exclusive credentials, keeps safe ones, and creates a backup', () => {
    const p = join(tmpDir, '.env')
    writeFileSync(p, [
      '# comment',
      'OPENAI_API_KEY=sk-xxx',
      'WEIXIN_TOKEN=secret-token',
      'WEIXIN_ACCOUNT_ID=acct-1',
      'TELEGRAM_BOT_TOKEN=tg-token',
      'PORT=8642',
      '',
    ].join('\n'))

    const removed = stripExclusivePlatformCredentials(p)
    expect(removed).toEqual(['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID', 'TELEGRAM_BOT_TOKEN'])

    const after = readFileSync(p, 'utf-8')
    expect(after).toContain('OPENAI_API_KEY=sk-xxx')
    expect(after).toContain('PORT=8642')
    expect(after).toContain('# comment')
    expect(after).not.toContain('WEIXIN_')
    expect(after).not.toContain('TELEGRAM_')

    // 备份文件存在且与原始内容一致
    const backups = readdirSync(tmpDir).filter(f => f.startsWith('.env.bak'))
    expect(backups).toHaveLength(1)
    const backupContent = readFileSync(join(tmpDir, backups[0]), 'utf-8')
    expect(backupContent).toContain('WEIXIN_TOKEN=secret-token')
  })
})

describe('disableExclusivePlatformsInConfig', () => {
  it('returns empty when file does not exist', () => {
    expect(disableExclusivePlatformsInConfig(join(tmpDir, 'nope.yaml')))
      .toEqual({ disabled: [], strippedConfigCredentials: [] })
  })

  it('returns empty when no exclusive platforms enabled and no embedded credentials', () => {
    const p = join(tmpDir, 'config.yaml')
    writeFileSync(p, 'platforms:\n  cli:\n    enabled: true\n')
    expect(disableExclusivePlatformsInConfig(p))
      .toEqual({ disabled: [], strippedConfigCredentials: [] })
    expect(readdirSync(tmpDir).filter(f => f.startsWith('config.yaml.bak'))).toHaveLength(0)
  })

  it('disables enabled exclusive platforms, strips embedded credentials, and backs up', () => {
    const p = join(tmpDir, 'config.yaml')
    writeFileSync(p, [
      'platforms:',
      '  cli:',
      '    enabled: true',
      '  weixin:',
      '    enabled: true',
      '    token: secret',
      '    extra:',
      '      account_id: acct-1',
      '      app_id: app-1',
      '  telegram:',
      '    enabled: true',
      '    bot_token: tg-token',
      '  feishu:',
      '    enabled: true',
      '    extra:',
      '      app_id: app-1',
      '      encrypt_key: enc-1',
      '      verification_token: verify-1',
      '  discord:',
      '    enabled: false',
      '',
    ].join('\n'))

    const result = disableExclusivePlatformsInConfig(p)
    expect(result.disabled.sort()).toEqual(['feishu', 'telegram', 'weixin'])
    // 节点直挂 + extra 子节点的凭据都应该被清掉
    expect(result.strippedConfigCredentials.sort()).toEqual([
      'feishu.extra.app_id',
      'feishu.extra.encrypt_key',
      'feishu.extra.verification_token',
      'telegram.bot_token',
      'weixin.extra.account_id',
      'weixin.extra.app_id',
      'weixin.token',
    ])

    const after = readFileSync(p, 'utf-8')
    expect(after).toMatch(/weixin:[\s\S]*?enabled:\s*false/)
    expect(after).toMatch(/feishu:[\s\S]*?enabled:\s*false/)
    expect(after).toMatch(/telegram:[\s\S]*?enabled:\s*false/)
    expect(after).toMatch(/cli:[\s\S]*?enabled:\s*true/)
    // 凭据已被清除
    expect(after).not.toContain('secret')
    expect(after).not.toContain('tg-token')
    expect(after).not.toContain('acct-1')

    const backups = readdirSync(tmpDir).filter(f => f.startsWith('config.yaml.bak'))
    expect(backups).toHaveLength(1)
  })

  it('strips embedded credentials even when platform is already disabled', () => {
    const p = join(tmpDir, 'config.yaml')
    writeFileSync(p, [
      'platforms:',
      '  weixin:',
      '    enabled: false',
      '    token: leftover-secret',
      '',
    ].join('\n'))

    const result = disableExclusivePlatformsInConfig(p)
    expect(result.disabled).toEqual([])
    expect(result.strippedConfigCredentials).toEqual(['weixin.token'])

    const after = readFileSync(p, 'utf-8')
    expect(after).not.toContain('leftover-secret')
  })

  it('returns empty on malformed yaml without throwing', () => {
    const p = join(tmpDir, 'config.yaml')
    writeFileSync(p, 'platforms: [unclosed')
    expect(disableExclusivePlatformsInConfig(p))
      .toEqual({ disabled: [], strippedConfigCredentials: [] })
  })
})

describe('copyModelProviderAuthForClone', () => {
  it('copies only the cloned model provider OAuth auth from the active source profile', () => {
    process.env.HERMES_HOME = tmpDir
    writeFileSync(join(tmpDir, 'active_profile'), 'default\n')
    writeFileSync(join(tmpDir, 'auth.json'), JSON.stringify({
      providers: {
        'openai-codex': { access_token: 'codex-provider-token' },
        anthropic: { access_token: 'anthropic-provider-token' },
      },
      credential_pool: {
        'openai-codex': [{ access_token: 'codex-pool-token' }],
        anthropic: [{ access_token: 'anthropic-pool-token' }],
      },
    }, null, 2))
    const cloneDir = join(tmpDir, 'profiles', 'cloned')
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(cloneDir, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      '',
    ].join('\n'))

    const copied = copyModelProviderAuthForClone('cloned')

    expect(copied).toEqual(['openai-codex'])
    const clonedAuth = JSON.parse(readFileSync(join(cloneDir, 'auth.json'), 'utf-8'))
    expect(clonedAuth.providers['openai-codex']).toEqual({ access_token: 'codex-provider-token' })
    expect(clonedAuth.credential_pool['openai-codex']).toEqual([{ access_token: 'codex-pool-token' }])
    expect(clonedAuth.providers.anthropic).toBeUndefined()
    expect(clonedAuth.credential_pool.anthropic).toBeUndefined()
  })

  it('copies the Claude OAuth runtime alias needed for chat execution', () => {
    process.env.HERMES_HOME = tmpDir
    writeFileSync(join(tmpDir, 'active_profile'), 'default\n')
    writeFileSync(join(tmpDir, 'auth.json'), JSON.stringify({
      providers: {
        'claude-oauth': { access_token: 'claude-oauth-token' },
        anthropic: { access_token: 'anthropic-runtime-token' },
        'openai-codex': { access_token: 'codex-provider-token' },
      },
      credential_pool: {
        'claude-oauth': [{ access_token: 'claude-oauth-pool-token' }],
        anthropic: [{ access_token: 'anthropic-runtime-pool-token' }],
        'openai-codex': [{ access_token: 'codex-pool-token' }],
      },
    }, null, 2))
    const cloneDir = join(tmpDir, 'profiles', 'cloned')
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(cloneDir, 'config.yaml'), [
      'model:',
      '  provider: claude-oauth',
      '  default: claude-sonnet-4',
      '',
    ].join('\n'))

    const copied = copyModelProviderAuthForClone('cloned')

    expect(copied.sort()).toEqual(['anthropic', 'claude-oauth'])
    const clonedAuth = JSON.parse(readFileSync(join(cloneDir, 'auth.json'), 'utf-8'))
    expect(clonedAuth.providers['claude-oauth']).toEqual({ access_token: 'claude-oauth-token' })
    expect(clonedAuth.providers.anthropic).toEqual({ access_token: 'anthropic-runtime-token' })
    expect(clonedAuth.credential_pool['claude-oauth']).toEqual([{ access_token: 'claude-oauth-pool-token' }])
    expect(clonedAuth.credential_pool.anthropic).toEqual([{ access_token: 'anthropic-runtime-pool-token' }])
    expect(clonedAuth.providers['openai-codex']).toBeUndefined()
    expect(clonedAuth.credential_pool['openai-codex']).toBeUndefined()
  })

  it('does not copy auth for API-key providers that should use env/config credentials', () => {
    process.env.HERMES_HOME = tmpDir
    writeFileSync(join(tmpDir, 'active_profile'), 'default\n')
    writeFileSync(join(tmpDir, 'auth.json'), JSON.stringify({
      providers: {
        anthropic: { access_token: 'anthropic-provider-token' },
      },
      credential_pool: {
        anthropic: [{ access_token: 'anthropic-pool-token' }],
      },
    }, null, 2))
    const cloneDir = join(tmpDir, 'profiles', 'cloned')
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(cloneDir, 'config.yaml'), [
      'model:',
      '  provider: anthropic',
      '  default: claude-sonnet-4',
      '',
    ].join('\n'))

    expect(copyModelProviderAuthForClone('cloned')).toEqual([])
    expect(existsSync(join(cloneDir, 'auth.json'))).toBe(false)
  })

  it('does not copy auth for keyless providers that are not stored OAuth providers', () => {
    process.env.HERMES_HOME = tmpDir
    writeFileSync(join(tmpDir, 'active_profile'), 'default\n')
    writeFileSync(join(tmpDir, 'auth.json'), JSON.stringify({
      providers: {
        'fun-codex': { access_token: 'stale-fun-token' },
      },
      credential_pool: {
        'fun-codex': [{ access_token: 'stale-fun-pool-token' }],
      },
    }, null, 2))
    const cloneDir = join(tmpDir, 'profiles', 'cloned')
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(cloneDir, 'config.yaml'), [
      'model:',
      '  provider: fun-codex',
      '  default: gpt-5.5',
      '',
    ].join('\n'))

    expect(copyModelProviderAuthForClone('cloned')).toEqual([])
    expect(existsSync(join(cloneDir, 'auth.json'))).toBe(false)
  })
})

describe('EXCLUSIVE_PLATFORMS list', () => {
  it('stays in sync with the env pattern list (same length)', () => {
    expect(EXCLUSIVE_PLATFORMS.length).toBe(EXCLUSIVE_PLATFORM_ENV_PATTERNS.length)
  })
})
