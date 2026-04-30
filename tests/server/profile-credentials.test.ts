import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isExclusivePlatformKey,
  stripExclusivePlatformCredentials,
  disableExclusivePlatformsInConfig,
  EXCLUSIVE_PLATFORMS,
  EXCLUSIVE_PLATFORM_ENV_PATTERNS,
} from '../../packages/server/src/services/hermes/profile-credentials'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'profile-cred-test-'))
})

afterEach(() => {
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
      'FEISHU_APP_ID',
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
      '  discord:',
      '    enabled: false',
      '',
    ].join('\n'))

    const result = disableExclusivePlatformsInConfig(p)
    expect(result.disabled.sort()).toEqual(['telegram', 'weixin'])
    // 节点直挂 + extra 子节点的凭据都应该被清掉
    expect(result.strippedConfigCredentials.sort()).toEqual([
      'telegram.bot_token',
      'weixin.extra.account_id',
      'weixin.extra.app_id',
      'weixin.token',
    ])

    const after = readFileSync(p, 'utf-8')
    expect(after).toMatch(/weixin:[\s\S]*?enabled:\s*false/)
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

describe('EXCLUSIVE_PLATFORMS list', () => {
  it('stays in sync with the env pattern list (same length)', () => {
    expect(EXCLUSIVE_PLATFORMS.length).toBe(EXCLUSIVE_PLATFORM_ENV_PATTERNS.length)
  })
})
