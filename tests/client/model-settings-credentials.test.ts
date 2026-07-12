// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const {
  updateProviderMock,
  fetchProvidersMock,
  reloadModelsMock,
  successMock,
  warningMock,
  errorMock,
  modelsStoreMock,
} = vi.hoisted(() => ({
  updateProviderMock: vi.fn(),
  fetchProvidersMock: vi.fn(),
  reloadModelsMock: vi.fn(),
  successMock: vi.fn(),
  warningMock: vi.fn(),
  errorMock: vi.fn(),
  modelsStoreMock: {
    providers: [] as any[],
    loading: false,
    fetchProviders: vi.fn(),
  },
}))
modelsStoreMock.fetchProviders = fetchProvidersMock

vi.mock('@/stores/hermes/models', () => ({
  useModelsStore: () => modelsStoreMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ reloadModels: reloadModelsMock }),
}))

vi.mock('@/api/hermes/system', () => ({
  updateProvider: updateProviderMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => {
  const NInput = defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: {
      value: { type: String, default: '' },
      placeholder: { type: String, default: '' },
    },
    emits: ['update:value'],
    setup(props, { emit, attrs }) {
      return () => h('input', {
        ...attrs,
        class: 'credential-input',
        value: props.value,
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  })
  const NButton = defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: {
      disabled: Boolean,
      loading: Boolean,
    },
    emits: ['click'],
    setup(props, { slots, emit, attrs }) {
      return () => h('button', {
        ...attrs,
        class: 'save-button',
        disabled: props.disabled,
        onClick: () => emit('click'),
      }, slots.default?.())
    },
  })
  const passthrough = (name: string) => defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', slots.default?.())
    },
  })
  return {
    NInput,
    NButton,
    NSpin: passthrough('NSpin'),
    NEmpty: passthrough('NEmpty'),
    useMessage: () => ({ success: successMock, warning: warningMock, error: errorMock }),
  }
})

import ModelSettings from '@/components/hermes/settings/ModelSettings.vue'

beforeEach(() => {
  vi.clearAllMocks()
  modelsStoreMock.providers = [
    {
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
      api_key: 'browser-must-ignore-this-value',
      has_api_key: true,
      builtin: true,
    },
    {
      provider: 'custom:dict-proxy',
      label: 'Dict Proxy',
      base_url: 'https://dict.invalid/v1',
      models: ['dict-model'],
      api_key: 'browser-must-ignore-custom-value',
      has_api_key: true,
      builtin: true,
      provider_source: 'providers',
      provider_key: 'dict-proxy-entry',
    },
  ]
})

describe('ModelSettings credential behavior', () => {
  it('keeps stored placeholders empty and targets custom updates by explicit identity/source', async () => {
    const wrapper = mount(ModelSettings)
    const inputs = wrapper.findAll<HTMLInputElement>('input.credential-input')
    const buttons = wrapper.findAll<HTMLButtonElement>('button.save-button')

    expect(inputs).toHaveLength(2)
    expect(inputs.map(input => input.element.value)).toEqual(['', ''])
    expect(inputs.map(input => input.attributes('placeholder'))).toEqual(['••••••••', '••••••••'])
    expect(buttons.map(button => button.element.disabled)).toEqual([true, true])
    expect(wrapper.text()).toContain('models.customType')

    await inputs[1].setValue('replacement-value')
    expect(buttons[1].element.disabled).toBe(false)
    await buttons[1].trigger('click')

    expect(updateProviderMock).toHaveBeenCalledWith('custom:dict-proxy', {
      api_key: 'replacement-value',
      provider_source: 'providers',
      provider_key: 'dict-proxy-entry',
    })
    expect(fetchProvidersMock).toHaveBeenCalledTimes(1)
    expect(reloadModelsMock).toHaveBeenCalledWith({ preserveSelection: true })
    expect(inputs[1].element.value).toBe('')
    expect(successMock).toHaveBeenCalled()
  })

  it('does not call the update API for blank replacements', async () => {
    const wrapper = mount(ModelSettings)
    const buttons = wrapper.findAll<HTMLButtonElement>('button.save-button')

    await buttons[0].trigger('click')
    await buttons[1].trigger('click')

    expect(updateProviderMock).not.toHaveBeenCalled()
  })
})
