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
    const skillsPanel = readClientFile('components/coding-agents/CodingAgentSkillsPanel.vue')
    const mcpPanel = readClientFile('components/coding-agents/CodingAgentMcpPanel.vue')

    expect(view).not.toContain('NEmpty')
    expect(view).not.toContain("router.push({ name: 'hermes.agentManager' })")
    expect(view).toContain('readCodingAgentConfigFile')
    expect(view).toContain('writeCodingAgentConfigFile')
    expect(view).toContain('<CodingAgentSkillsPanel :target="skillTarget" />')
    expect(view).toContain('<CodingAgentMcpPanel :agent-id="validAgentId" />')
    expect(view).toMatch(/\.coding-agent-config-view\s*\{[\s\S]*height:\s*100%/)
    expect(view).toMatch(/\.coding-agent-mcp-content\s*\{[\s\S]*flex:\s*1;[\s\S]*min-height:\s*0/)
    expect(mcpPanel).toMatch(/\.mcp-view\.embedded\s*\{[\s\S]*height:\s*100%;[\s\S]*min-height:\s*0/)
    expect(view).toContain("'claude-code': { memory: 'memory', mcp: 'mcp', settings: 'settings' }")
    expect(view).toContain("codex: { memory: 'agents', mcp: 'config', settings: 'config' }")
    expect(view).toContain("pi: { memory: 'agents', mcp: 'mcp', settings: 'settings' }")
    expect(view).toContain("grok: { memory: 'agents', mcp: 'mcp', settings: 'settings' }")
    expect(view).not.toContain("sessionId: 'latest'")
    expect(view).not.toContain('grokEffectiveView')
    expect(view).not.toContain(':readonly=')
    expect(skills).toContain('target?: SkillTarget')
    expect(skills).toContain('<SkillSourceLegend v-model="sourceFilter" />')
    expect(skillsPanel).toContain('<SkillsView :target="target" embedded />')
    expect(mcpPanel).toContain('<McpServerCard')
    expect(mcpPanel).toContain(':readonly="server.managed"')
    expect(mcpPanel).toContain(':allow-readonly-edit="true"')
    expect(mcpPanel).toContain('probeEnabledServers')
    expect(mcpPanel).toContain(':show-manage-tools="false"')
    expect(mcpPanel).toContain('toolsByServer')
    expect(mcpPanel).toContain('@click="reloadAllServers"')
    expect(mcpPanel).toContain("t('mcp.reloadAll')")
    expect(mcpPanel).toContain("message.success(t('mcp.reloadedAll'))")
    expect(mcpPanel).not.toContain('showToolsModal')
  })
})
