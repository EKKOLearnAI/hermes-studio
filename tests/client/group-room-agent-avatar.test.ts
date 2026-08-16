// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { RoomAgentSummary } from '@/api/hermes/group-chat'
import GroupRoomAgentAvatar from '@/components/hermes/group-chat/GroupRoomAgentAvatar.vue'

vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: {
    props: ['name', 'size'],
    template: '<span class="profile-avatar-stub" :data-name="name" :data-size="size" />',
  },
}))

function agent(index: number): RoomAgentSummary {
  return {
    id: `row-${index}`,
    roomId: 'room-1',
    agentId: `agent-${index}`,
    agent: index % 2 ? 'codex' : 'hermes',
    name: `Agent ${index}`,
    avatar: '',
  }
}

describe('GroupRoomAgentAvatar', () => {
  it.each([
    { count: 1, visibleAgents: 1, overflow: '' },
    { count: 2, visibleAgents: 2, overflow: '' },
    { count: 3, visibleAgents: 3, overflow: '' },
    { count: 4, visibleAgents: 4, overflow: '' },
    { count: 5, visibleAgents: 3, overflow: '+2' },
  ])('renders the fixed $count-agent grid', ({ count, visibleAgents, overflow }) => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: Array.from({ length: count }, (_, index) => agent(index + 1)),
        activeAgentIds: [],
        label: 'Room agents',
      },
    })

    expect(wrapper.get('.room-agent-grid').attributes('data-agent-count')).toBe(String(Math.min(count, 4)))
    expect(wrapper.findAll('.room-agent-grid-cell.agent')).toHaveLength(visibleAgents)
    expect(wrapper.find('.room-agent-grid-overflow').exists()
      ? wrapper.get('.room-agent-grid-overflow').text()
      : '').toBe(overflow)
  })

  it('renders a stable neutral tile for an empty room', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: { agents: [], activeAgentIds: [], label: 'Room agents' },
    })

    expect(wrapper.get('.room-agent-grid').attributes('data-agent-count')).toBe('0')
    expect(wrapper.findAll('.room-agent-grid-cell')).toHaveLength(1)
    expect(wrapper.get('.room-agent-grid-neutral').exists()).toBe(true)
  })

  it('activates only the matching persistent Agent cell and deduplicates parallel runs', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: [agent(1), agent(2), agent(3)],
        activeAgentIds: ['row-2', 'row-2'],
        label: 'Room agents',
      },
    })

    expect(wrapper.findAll('.room-agent-grid-cell.is-active')).toHaveLength(1)
    expect(wrapper.get('[data-agent-id="row-2"]').classes()).toContain('is-active')
    expect(wrapper.get('[data-agent-id="row-2"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-agent-id="row-1"]').attributes('aria-busy')).toBe('false')
  })

  it('marks the overflow cell when only a hidden Agent is running', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: Array.from({ length: 6 }, (_, index) => agent(index + 1)),
        activeAgentIds: ['row-6'],
        label: 'Room agents',
      },
    })

    expect(wrapper.get('.room-agent-grid-overflow').text()).toBe('+3')
    expect(wrapper.get('.room-agent-grid-overflow').classes()).toContain('is-active')
    expect(wrapper.findAll('.room-agent-grid-cell.agent.is-active')).toHaveLength(0)
  })
})
