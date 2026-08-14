import { describe, expect, it } from 'vitest'
import {
  codexMcpConfigToml,
  parseCodexExternalMcpBlocks,
  parseCodexExternalTomlBlocks,
} from '../../packages/server/src/services/coding-agents'

// 模拟 hermes-web-ui 管理生成的 MCP 段（含 HERMES_WEB_UI_MANAGED_MCP 标记）
const MANAGED_HERMES_BLOCK = `[mcp_servers.hermes-studio-api]
command = "/usr/local/bin/node"
args = ["/home/i1j/.npm-global/lib/node_modules/hermes-web-ui/bin/hermes-studio-mcp.mjs", "api"]
startup_timeout_sec = 120
env = { HERMES_WEB_UI_MANAGED_MCP = "1" }`

// 用户自定义的 features 段（codex_apps 修复：openai/codex#29396）
const USER_FEATURES_BLOCK = `[features]
apps = false`

// 用户自定义的外部 MCP server
const USER_EXTERNAL_MCP_BLOCK = `[mcp_servers.my-tools]
command = "/usr/local/bin/my-mcp"
startup_timeout_sec = 60`

describe('parseCodexExternalMcpBlocks', () => {
  it('保留用户配置的外部 MCP server 段', () => {
    const blocks = parseCodexExternalMcpBlocks(USER_EXTERNAL_MCP_BLOCK)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('[mcp_servers.my-tools]')
    expect(blocks[0]).toContain('startup_timeout_sec = 60')
  })

  it('过滤 hermes-web-ui 管理的 MCP 段（含 MANAGED 标记）', () => {
    const blocks = parseCodexExternalMcpBlocks(MANAGED_HERMES_BLOCK)
    expect(blocks).toHaveLength(0)
  })

  it('空输入返回空数组', () => {
    expect(parseCodexExternalMcpBlocks('', null, undefined)).toEqual([])
  })
})

describe('parseCodexExternalTomlBlocks', () => {
  it('保留用户自定义的 [features] 段（codex_apps 修复核心）', () => {
    const blocks = parseCodexExternalTomlBlocks(USER_FEATURES_BLOCK)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('[features]')
    expect(blocks[0]).toContain('apps = false')
  })

  it('不重复收集外部 MCP server 段（由 parseCodexExternalMcpBlocks 处理）', () => {
    const blocks = parseCodexExternalTomlBlocks(USER_EXTERNAL_MCP_BLOCK)
    expect(blocks).toHaveLength(0)
  })

  it('不收集 hermes-studio-* 管理段', () => {
    const blocks = parseCodexExternalTomlBlocks(MANAGED_HERMES_BLOCK)
    expect(blocks).toHaveLength(0)
  })

  it('排除 model_providers.* 段（由 hermes-web-ui 依据当前 provider 重建）', () => {
    const input = `[model_providers.unrelated]
name = "should-not-be-copied"

[features]
apps = false`
    const blocks = parseCodexExternalTomlBlocks(input)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('[features]')
    expect(blocks[0]).not.toContain('model_providers')
  })

  it('保留多个独立顶层段', () => {
    const input = `${USER_FEATURES_BLOCK}

[projects."/tmp/workspace"]
trust_level = "trusted"`
    const blocks = parseCodexExternalTomlBlocks(input)
    expect(blocks).toHaveLength(2)
  })

  it('空输入返回空数组', () => {
    expect(parseCodexExternalTomlBlocks('', null, undefined)).toEqual([])
  })
})

describe('codexMcpConfigToml', () => {
  it('生成的 config 同时包含用户 [features] 段与 4 个 hermes MCP 段', () => {
    const toml = codexMcpConfigToml(
      'tester',
      `${USER_FEATURES_BLOCK}\n\n${MANAGED_HERMES_BLOCK}\n\n${USER_EXTERNAL_MCP_BLOCK}`,
    )
    // 用户 features 保留
    expect(toml).toContain('[features]')
    expect(toml).toContain('apps = false')
    // 外部 MCP 保留
    expect(toml).toContain('[mcp_servers.my-tools]')
    // 4 个 hermes MCP 段各出现一次（不重复）
    for (const name of ['hermes-studio-api', 'hermes-studio-browser', 'hermes-studio-devices', 'hermes-studio-use']) {
      const occurrences = toml.split(`[mcp_servers.${name}]`).length - 1
      expect(occurrences).toBe(1)
    }
    // 不含 managed 标记的旧 hermes 段（由新段替代）
    expect(toml).not.toContain('[mcp_servers.hermes-studio]')
  })

  it('无外部内容时仅输出 4 个 hermes MCP 段', () => {
    const toml = codexMcpConfigToml('tester', '')
    for (const name of ['hermes-studio-api', 'hermes-studio-browser', 'hermes-studio-devices', 'hermes-studio-use']) {
      expect(toml).toContain(`[mcp_servers.${name}]`)
    }
  })
})
