// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    profileModelGroups: [],
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ profiles: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/shared/session-display', () => ({
  formatTimestampMs: () => 'now',
}))

vi.mock('naive-ui', () => ({
  NPopconfirm: defineComponent({
    name: 'NPopconfirm',
    emits: ['positive-click'],
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['click'],
    template: '<input type="checkbox" :checked="checked" @click="$emit(\'click\')" />',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
}))

const session = {
  id: 's1',
  title: 'Session One',
  model: 'gpt-test',
  provider: 'openai',
  createdAt: Date.now(),
  profile: 'kira',
}

describe('SessionListItem', () => {
  it('renders normal mode as a link to the session route', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    expect(link.attributes('href')).toBe('/session/s1')
    expect(wrapper.find('button.session-item').exists()).toBe(false)
  })

  it('renders selectable mode as a button and does not expose row href', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        selectable: true,
        selected: false,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    expect(wrapper.find('button.session-item').exists()).toBe(true)
    expect(wrapper.find('a.session-item').exists()).toBe(false)
  })

  it('does not select the row when clicking nested action controls', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    await wrapper.get('button.session-item-delete').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('does not hijack modified clicks on normal links', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        pinned: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    link.element.addEventListener('click', event => event.preventDefault())
    await link.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('renders the Hermes logo for Hermes sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'cli', agent: 'hermes' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('defaults old sessions without agent metadata to the Hermes logo', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: undefined, agent: undefined, codingAgentId: undefined },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Claude Code logo for Claude coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'claude', codingAgentId: 'claude-code' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/claude-code.svg')
    expect(logo.attributes('alt')).toBe('Claude Code')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Codex logo for Codex coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' },
        active: false,
        pinned: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/codex-openai.png')
    expect(logo.attributes('alt')).toBe('Codex')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })
})
