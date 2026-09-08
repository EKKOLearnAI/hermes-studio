// @vitest-environment jsdom
import { shallowMount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'

const server = {
  name: 'demo',
  transport: 'stdio',
  connected: false,
  tools: 0,
  tools_registered: 0,
  tool_names: [],
  tool_names_registered: [],
  tool_details: [],
  error: null,
  raw_config: {
    command: 'node',
    enabled: true,
  },
}

describe('McpServerCard connection status', () => {
  it('uses a neutral loading state while the server is being tested', async () => {
    const wrapper = shallowMount(McpServerCard, {
      props: {
        server,
        toolsByServer: {},
        testing: true,
      },
    })

    expect(wrapper.get('.mcp-card').classes()).toContain('testing')
    expect(wrapper.get('.mcp-card').classes()).not.toContain('disconnected')
    expect(wrapper.get('.type-badge.testing').text()).toBe('mcp.loading')

    await wrapper.setProps({ testing: false })

    expect(wrapper.get('.mcp-card').classes()).not.toContain('testing')
    expect(wrapper.get('.mcp-card').classes()).toContain('disconnected')
    expect(wrapper.get('.type-badge.disconnected').text()).toBe('mcp.disconnectedStatus')
  })

  it('does not mark disabled servers as disconnected', () => {
    const wrapper = shallowMount(McpServerCard, {
      props: {
        server: {
          ...server,
          raw_config: { ...server.raw_config, enabled: false },
        },
        toolsByServer: {},
      },
    })

    expect(wrapper.get('.mcp-card').classes()).toContain('disabled')
    expect(wrapper.get('.mcp-card').classes()).not.toContain('disconnected')
    expect(wrapper.get('.type-badge.disabled').text()).toBe('mcp.disabledStatus')
  })
})
