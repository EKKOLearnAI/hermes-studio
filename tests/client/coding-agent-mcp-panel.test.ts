// @vitest-environment jsdom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  add: vi.fn(),
  fetch: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/api/coding-agent-mcp', () => ({
  addCodingAgentMcpServer: api.add,
  fetchCodingAgentMcpServers: api.fetch,
  removeCodingAgentMcpServer: api.remove,
  testCodingAgentMcpServer: api.test,
  updateCodingAgentMcpServer: api.update,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  }
})

import CodingAgentMcpPanel from '@/components/coding-agents/CodingAgentMcpPanel.vue'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function response(name: string, managed = false) {
  return {
    ok: true,
    total_tools: 0,
    servers: [{
      name,
      transport: 'stdio',
      connected: false,
      tools: 0,
      tools_registered: 0,
      tool_names: [],
      tool_names_registered: [],
      tool_details: [],
      error: null,
      raw_config: { command: name, enabled: true },
      managed,
    }],
  }
}

describe('CodingAgentMcpPanel Agent changes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.update.mockResolvedValue({ ok: true })
    api.test.mockResolvedValue({ ok: true, tools: [], tool_details: [] })
  })

  it('sends only the enabled field when toggling a Studio-managed server', async () => {
    api.fetch.mockResolvedValue(response('hermes-studio-api', true))
    const wrapper = shallowMount(CodingAgentMcpPanel, {
      props: { agentId: 'codex' },
    })
    await flushPromises()

    wrapper.getComponent(McpServerCard).vm.$emit('toggle-enabled')
    await flushPromises()

    expect(api.update).toHaveBeenCalledWith('codex', 'hermes-studio-api', { enabled: false })
  })

  it('keeps the full configuration when toggling a custom server', async () => {
    api.fetch.mockResolvedValue(response('docs'))
    const wrapper = shallowMount(CodingAgentMcpPanel, {
      props: { agentId: 'codex' },
    })
    await flushPromises()

    wrapper.getComponent(McpServerCard).vm.$emit('toggle-enabled')
    await flushPromises()

    expect(api.update).toHaveBeenCalledWith('codex', 'docs', {
      command: 'docs',
      enabled: false,
    })
  })

  it('ignores list and probe work that finishes after switching Agents', async () => {
    const codex = deferred<ReturnType<typeof response>>()
    const claude = deferred<ReturnType<typeof response>>()
    api.fetch.mockImplementation((agentId: string) =>
      agentId === 'codex' ? codex.promise : claude.promise,
    )

    const wrapper = shallowMount(CodingAgentMcpPanel, {
      props: { agentId: 'codex' },
    })
    await wrapper.setProps({ agentId: 'claude-code' })

    claude.resolve(response('claude-server'))
    await flushPromises()
    expect(wrapper.getComponent(McpServerCard).props('server').name).toBe('claude-server')

    codex.resolve(response('codex-server'))
    await flushPromises()

    expect(wrapper.getComponent(McpServerCard).props('server').name).toBe('claude-server')
    expect(api.test).toHaveBeenCalledWith('claude-code', 'claude-server')
    expect(api.test).not.toHaveBeenCalledWith('claude-code', 'codex-server')
  })
})
