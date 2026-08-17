// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  fetchAuxiliaryModels: vi.fn(),
  fetchDelegationModel: vi.fn(),
  saveAuxiliaryModels: vi.fn(),
  saveDelegationModel: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

const modelsStore = vi.hoisted(() => ({
  providers: [
    { provider: 'openrouter', label: 'OpenRouter', models: ['old-model'] },
    { provider: 'anthropic', label: 'Anthropic', models: ['claude-sonnet'] },
  ],
}))

const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
}))

vi.mock('@/api/hermes/config', () => apiMocks)
vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => modelsStore }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStore }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NButton: defineComponent({
      name: 'NButton',
      props: { disabled: Boolean, loading: Boolean },
      emits: ['click'],
      setup(props, { attrs, emit, slots }) {
        return () => h('button', {
          ...attrs,
          disabled: props.disabled,
          onClick: () => emit('click'),
        }, slots.default?.())
      },
    }),
    NInput: defineComponent({ name: 'NInput', template: '<input />' }),
    NInputNumber: defineComponent({ name: 'NInputNumber', template: '<input />' }),
    NModal: defineComponent({
      name: 'NModal',
      props: { show: Boolean },
      emits: ['update:show'],
      setup(props, { slots }) {
        return () => props.show
          ? h('div', { class: 'modal-stub' }, [slots.default?.(), slots.footer?.()])
          : null
      },
    }),
    NSelect: defineComponent({
      name: 'NSelect',
      props: {
        value: [String, Number],
        options: Array,
        placeholder: String,
        disabled: Boolean,
        filterable: Boolean,
        clearable: Boolean,
      },
      emits: ['update:value'],
      setup(props, { attrs, emit }) {
        return () => h('select', {
          ...attrs,
          value: props.value,
          disabled: props.disabled,
          onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
        })
      },
    }),
    NSpin: defineComponent({
      name: 'NSpin',
      setup(_props, { slots }) {
        return () => h('div', slots.default?.())
      },
    }),
    useMessage: () => messageMock,
  }
})

import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'

describe('AuxiliaryModelsPanel delegation model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchAuxiliaryModels.mockResolvedValue({ tasks: [], auxiliary: {} })
    apiMocks.fetchDelegationModel.mockResolvedValue({
      delegation: { provider: 'openrouter', model: 'old-model', reasoning_effort: 'low' },
    })
    apiMocks.saveDelegationModel
      .mockResolvedValueOnce({
        success: true,
        delegation: { provider: 'anthropic', model: 'claude-sonnet', reasoning_effort: 'high' },
      })
      .mockResolvedValueOnce({ success: true, delegation: {} })
  })

  it('loads, saves, and resets the Profile delegation route from server responses', async () => {
    const wrapper = mount(AuxiliaryModelsPanel)
    await flushPromises()

    expect(apiMocks.fetchAuxiliaryModels).toHaveBeenCalledOnce()
    expect(apiMocks.fetchDelegationModel).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('openrouter / old-model')

    await wrapper.get('[data-testid="delegation-edit"]').trigger('click')
    const selects = wrapper.findAllComponents({ name: 'NSelect' })
    expect(selects).toHaveLength(3)
    selects[0].vm.$emit('update:value', 'anthropic')
    await wrapper.vm.$nextTick()
    selects[1].vm.$emit('update:value', 'claude-sonnet')
    selects[2].vm.$emit('update:value', 'high')
    await wrapper.get('[data-testid="delegation-save"]').trigger('click')
    await flushPromises()

    expect(apiMocks.saveDelegationModel).toHaveBeenNthCalledWith(1, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoning_effort: 'high',
    })
    expect(wrapper.text()).toContain('anthropic / claude-sonnet')

    await wrapper.get('[data-testid="delegation-reset"]').trigger('click')
    await flushPromises()

    expect(apiMocks.saveDelegationModel).toHaveBeenNthCalledWith(2, {})
    expect(wrapper.text()).toContain('models.delegationInheritMain')
    expect(messageMock.success).toHaveBeenCalledTimes(2)
  })
})
