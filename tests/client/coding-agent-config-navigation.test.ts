import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('coding Agent configuration navigation', () => {
  it('adds a settings entry for every coding Agent card', () => {
    const manager = readClientFile('views/hermes/AgentManagerView.vue')

    expect(manager).toContain(':data-testid="`agent-settings-${agent.id}`"')
    expect(manager).toContain("name: 'codingAgent.config'")
    expect(manager).toContain("params: { agentId: agent.id, section: 'settings' }")
  })

  it('shows memory, skills, MCP, and settings in the Agent configuration sidebar', () => {
    const app = readClientFile('App.vue')
    const router = readClientFile('router/index.ts')
    const sidebar = readClientFile('components/layout/CodingAgentConfigSidebar.vue')

    expect(router).toContain("path: '/studio/agents/:agentId/:section(memory|skills|mcp|settings)'")
    expect(router).toContain("name: 'codingAgent.config'")
    expect(router).toContain('codingAgentConfig: true')
    expect(app).toContain('@/components/layout/CodingAgentConfigSidebar.vue')
    expect(app).toContain('route.meta?.codingAgentConfig === true')

    for (const section of ['memory', 'skills', 'mcp', 'settings']) {
      expect(sidebar).toContain(`section: '${section}'`)
    }
    expect(sidebar).toContain("name: 'hermes.agentManager'")
    expect(sidebar).toContain('@include agent-config-sidebar.layout("coding-agent")')
  })

  it('renders working content instead of empty placeholders for every section', () => {
    const view = readClientFile('views/hermes/CodingAgentConfigView.vue')
    const skills = readClientFile('views/hermes/SkillsView.vue')

    expect(view).not.toContain('NEmpty')
    expect(view).not.toContain("router.push({ name: 'hermes.agentManager' })")
    expect(view).toContain('readCodingAgentConfigFile')
    expect(view).toContain('writeCodingAgentConfigFile')
    expect(view).toContain('<SkillsView :target="skillTarget" embedded />')
    expect(view).toContain("'claude-code': { memory: 'memory', mcp: 'mcp', settings: 'settings' }")
    expect(view).toContain("codex: { memory: 'agents', mcp: 'config', settings: 'config' }")
    expect(view).toContain("pi: { memory: 'agents', mcp: 'mcp', settings: 'settings' }")
    expect(view).toContain("grok: { memory: 'agents', mcp: 'config', settings: 'config' }")
    expect(skills).toContain('target?: SkillTarget')
  })
})
