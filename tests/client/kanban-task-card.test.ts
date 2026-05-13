// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, number>) => {
      if (key === 'kanban.card.timeAgo.justNow') return '刚刚'
      if (key === 'kanban.card.timeAgo.minutes') return `${params?.count}分钟前`
      if (key === 'kanban.card.timeAgo.hours') return `${params?.count}小时前`
      if (key === 'kanban.card.timeAgo.days') return `${params?.count}天前`
      if (key === 'kanban.card.priority.high') return '高'
      if (key === 'kanban.card.priority.medium') return '中'
      if (key === 'kanban.card.priority.low') return '低'
      if (key === 'kanban.card.assigneeTooltip') return '负责人'
      return key
    },
  }),
}))

vi.mock('naive-ui', () => ({
  NTooltip: defineComponent({
    name: 'NTooltip',
    template: '<div class="n-tooltip-stub"><slot name="trigger" /><div class="tooltip-content"><slot /></div></div>',
  }),
}))

import KanbanTaskCard from '@/components/hermes/kanban/KanbanTaskCard.vue'

describe('KanbanTaskCard i18n', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders localized priority, tooltip, and relative time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T03:00:00Z'))

    const wrapper = mount(KanbanTaskCard, {
      props: {
        task: {
          id: 'task-1',
          title: 'Ship kanban i18n',
          body: 'Body preview content',
          assignee: 'alice',
          status: 'todo',
          priority: 3,
          created_by: null,
          created_at: Math.floor(new Date('2026-05-08T02:58:00Z').getTime() / 1000),
          started_at: null,
          completed_at: null,
          workspace_kind: 'local',
          workspace_path: null,
          tenant: null,
          result: null,
          skills: null,
        },
      },
    })

    expect(wrapper.text()).toContain('高')
    expect(wrapper.text()).toContain('2分钟前')
    expect(wrapper.text()).toContain('负责人')
  })
})
