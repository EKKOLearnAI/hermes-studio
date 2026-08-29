// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { RoomAgentSummary } from '@/api/studio/group-chat'
import GroupRoomAgentAvatar from '@/components/hermes/group-chat/GroupRoomAgentAvatar.vue'

const messages: Record<string, string> = {
  'groupChat.roomAgentAvatarEmpty': '{room}. No Room Agents. No Agents are running.',
  'groupChat.roomAgentAvatarIdle': '{room}. Room Agents: {agents}. No Agents are running.',
  'groupChat.roomAgentAvatarRunning': '{room}. Room Agents: {agents}. Running Agents: {running}.',
}

vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: {
    props: ['name', 'size'],
    template: '<span class="profile-avatar-stub" :data-name="name" :data-size="size" />',
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params: Record<string, string>) => (
      Object.entries(params).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, value),
        messages[key] || key,
      )
    ),
  }),
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
    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).toBe(
      'Room agents. No Room Agents. No Agents are running.',
    )
    expect(wrapper.get('.room-agent-grid').attributes('title')).toBe(
      'Room agents. No Room Agents. No Agents are running.',
    )
  })

  it('identifies the complete roster and explicitly reports an idle room', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: [agent(1), agent(2), agent(3)],
        activeAgentIds: [],
        label: 'Room agents',
      },
    })

    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).toBe(
      'Room agents. Room Agents: Agent 1, Agent 2, Agent 3. No Agents are running.',
    )
    expect(wrapper.get('.room-agent-grid').attributes('title')).toBe(
      'Room agents. Room Agents: Agent 1, Agent 2, Agent 3. No Agents are running.',
    )
  })

  it('activates the complete room avatar when a visible Agent is running', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: [agent(1), agent(2), agent(3)],
        activeAgentIds: ['row-2', 'row-2'],
        label: 'Room agents',
      },
    })

    expect(wrapper.get('.room-agent-grid').classes()).toContain('is-active')
    expect(wrapper.get('.room-agent-grid').attributes('aria-busy')).toBe('true')
    expect(wrapper.findAll('.room-agent-grid-cell.is-active')).toHaveLength(0)
    expect(wrapper.get('[data-agent-id="row-2"]').attributes('aria-busy')).toBeUndefined()
    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).toBe(
      'Room agents. Room Agents: Agent 1, Agent 2, Agent 3. Running Agents: Agent 2.',
    )
  })

  it('activates the complete room avatar when only a hidden Agent is running', () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: Array.from({ length: 6 }, (_, index) => agent(index + 1)),
        activeAgentIds: ['row-6'],
        label: 'Room agents',
      },
    })

    expect(wrapper.get('.room-agent-grid-overflow').text()).toBe('+3')
    expect(wrapper.get('.room-agent-grid').classes()).toContain('is-active')
    expect(wrapper.get('.room-agent-grid').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.room-agent-grid-overflow').classes()).not.toContain('is-active')
    expect(wrapper.findAll('.room-agent-grid-cell.is-active')).toHaveLength(0)
    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).toBe(
      'Room agents. Room Agents: Agent 1, Agent 2, Agent 3, Agent 4, Agent 5, Agent 6. Running Agents: Agent 6.',
    )
  })

  it('changes the accessible name when an Agent starts running', async () => {
    const wrapper = mount(GroupRoomAgentAvatar, {
      props: {
        agents: [agent(1), agent(2)],
        activeAgentIds: [],
        label: 'Room agents',
      },
    })
    const idleLabel = wrapper.get('.room-agent-grid').attributes('aria-label')

    await wrapper.setProps({ activeAgentIds: ['row-1'] })

    expect(wrapper.get('.room-agent-grid').classes()).toContain('is-active')
    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).not.toBe(idleLabel)
    expect(wrapper.get('.room-agent-grid').attributes('aria-label')).toContain('Running Agents: Agent 1.')
  })
})
