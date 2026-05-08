// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const mockCreateTask = vi.hoisted(() => vi.fn())
const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores/hermes/kanban', () => ({
  useKanbanStore: () => ({
    assignees: [{ name: 'alice', counts: { todo: 1 } }],
    createTask: mockCreateTask,
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    emits: ['close'],
    template: '<div class="n-modal-stub"><slot /><slot name="action" /></div>',
  }),
  NForm: defineComponent({ template: '<form><slot /></form>' }),
  NFormItem: defineComponent({ template: '<div><slot /></div>' }),
  NInput: defineComponent({
    props: { value: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSelect: defineComponent({
    props: { value: { required: false }, options: { type: Array, default: () => [] } },
    emits: ['update:value'],
    template: '<select class="n-select-stub" @change="$emit(\'update:value\', $event.target.value === \'\' ? null : (/^\\d+$/.test($event.target.value) ? Number($event.target.value) : $event.target.value))"><option value=""></option><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => mockMessage,
}))

import KanbanCreateForm from '@/components/hermes/kanban/KanbanCreateForm.vue'

describe('KanbanCreateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates required title before submit', async () => {
    const wrapper = mount(KanbanCreateForm)

    await wrapper.findAll('.n-button-stub')[1].trigger('click')

    expect(mockMessage.warning).toHaveBeenCalledWith('kanban.form.titleRequired')
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('submits trimmed values and emits created/close', async () => {
    mockCreateTask.mockResolvedValue({ id: 'task-1' })
    const wrapper = mount(KanbanCreateForm)

    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('  Ship kanban  ')
    await inputs[1].setValue('  write tests  ')
    const selects = wrapper.findAll('.n-select-stub')
    await selects[0].setValue('alice')
    await selects[1].setValue('3')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: 'Ship kanban',
      body: 'write tests',
      assignee: 'alice',
      priority: 3,
    })
    expect(mockMessage.success).toHaveBeenCalledWith('kanban.message.taskCreated')
    expect(wrapper.emitted('created')).toBeTruthy()
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
