// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NTag: { template: '<span><slot /></span>' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import KanbanTaskCard from '@/components/hermes/kanban/KanbanTaskCard.vue'

const task = {
  id: 't_0b1b8324',
  title: 'عاجل — تحليل التدفق وإضافة فلتر قبل الوكيل',
  status: 'todo',
  assignee: 'server-guard',
  priority: 0,
  created_at: Math.floor(Date.now() / 1000),
}

describe('kanban text direction follows the task, not the interface', () => {
  it('marks the card title so its own text decides the direction', () => {
    const wrapper = mount(KanbanTaskCard, { props: { task: task as any } })
    const title = wrapper.find('.card-title')

    expect(title.exists()).toBe(true)
    // Board columns and their labels stay in the interface direction; only the
    // text a person wrote is allowed to flip.
    expect(title.attributes('dir')).toBe('auto')
  })
})
