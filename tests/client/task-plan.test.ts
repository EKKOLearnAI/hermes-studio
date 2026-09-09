// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TaskPlanCard from '@/components/hermes/chat/TaskPlanCard.vue'
import { mergeTaskPlanMessages, type TaskPlanSnapshot } from '@/utils/task-plan'
import type { Message } from '@/stores/hermes/chat'
import en from '@/i18n/locales/en'

const plan: TaskPlanSnapshot = {
  session_id: 's1', run_id: 'r1', plan_id: 'r1', revision: 1, execution_state: 'running', created_at: 2, updated_at: 2,
  plan: [{ id: 'a', step: 'Inspect', status: 'completed' }, { id: 'b', step: 'Verify', status: 'pending' }],
}

describe('task plan display', () => {
  it('places one card before the associated run and ignores duplicate or stale replay', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Work', timestamp: 1 },
      { id: 'a', role: 'assistant', content: 'Done', timestamp: 3, runMarker: 'r1' },
    ]
    const initial = mergeTaskPlanMessages(messages, [plan])
    expect(initial.map(message => message.id)).toEqual(['u', 'task-plan:s1:r1', 'a'])
    const updated = mergeTaskPlanMessages(initial, [{ ...plan, revision: 3, execution_state: 'ended' }, plan, { ...plan, revision: 2 }])
    expect(updated).toHaveLength(3)
    expect(updated[1].taskPlan?.revision).toBe(3)
  })

  it('ignores malformed data and snapshots from another session', () => {
    expect(mergeTaskPlanMessages([], [{ ...plan, plan: [{ id: 'x', step: 'bad', status: 'done' }] }, plan], 's2')).toEqual([])
  })

  it('preserves multiple runs in a history page without merging their steps', () => {
    const messages = mergeTaskPlanMessages([], [plan, { ...plan, plan_id: 'r2', run_id: 'r2', created_at: 5 }])
    expect(messages).toHaveLength(2)
  })

  it('shows unfinished steps after interruption, updates the counter and supports folding', async () => {
    const wrapper = mount(TaskPlanCard, { props: { plan: { ...plan, execution_state: 'interrupted' } },
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    expect(wrapper.text()).toContain('1/2 completed')
    expect(wrapper.text()).toContain('Not completed')
    expect(wrapper.text()).toContain('Interrupted; unfinished steps remain')
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('ol').exists()).toBe(false)
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
    await wrapper.get('button').trigger('click')
    await wrapper.setProps({ plan: { ...plan, revision: 2, plan: plan.plan.map(step => ({ ...step, status: 'completed' })) } })
    expect(wrapper.text()).toContain('2/2 completed')
    expect(wrapper.findAll('.completed')).toHaveLength(2)
  })
})
