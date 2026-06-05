// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  gatewayAutoStart: { enabled: true, include: ['default'], exclude: [] as string[] },
  saveSection: vi.fn().mockResolvedValue(undefined),
  updateLocal: vi.fn((section: string, values: Record<string, any>) => {
    if (section === 'gatewayAutoStart') {
      mockSettingsStore.gatewayAutoStart = { ...mockSettingsStore.gatewayAutoStart, ...values }
    }
  }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  }
})

import GatewayAutoStartSettings from '@/components/hermes/settings/GatewayAutoStartSettings.vue'

describe('GatewayAutoStartSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.gatewayAutoStart = { enabled: true, include: ['default'], exclude: [] }
  })

  it('saves gateway auto-start enabled and include-list settings through app config section', async () => {
    const wrapper = mount(GatewayAutoStartSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><span class="setting-row-label">{{ label }}</span><slot /></div>',
          },
          'n-switch': {
            props: ['value'],
            emits: ['update:value'],
            template: `<button class="gateway-enabled" @click="$emit('update:value', !value)"></button>`,
          },
          'n-select': {
            props: ['value'],
            emits: ['update:value'],
            template: `<button class="gateway-mode" @click="$emit('update:value', value === 'include' ? 'all' : 'include')"></button>`,
          },
          'n-input': {
            props: ['value'],
            emits: ['update:value'],
            template: `<input class="gateway-list-input" :value="value" @input="$emit('update:value', ($event.target as HTMLInputElement).value)" />`,
          },
        },
      },
    })

    expect(wrapper.text()).toContain('settings.gatewayAutoStart.title')

    await wrapper.find('.n-switch').trigger('click')
    await Promise.resolve()
    expect(mockSettingsStore.updateLocal).toHaveBeenCalledWith('gatewayAutoStart', { enabled: false })
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('gatewayAutoStart', { enabled: false }, { restart: false })

    const inputs = wrapper.findAll('textarea')
    expect(inputs.length).toBe(2)
    await inputs[0].setValue('default, reviewer, default')
    await Promise.resolve()
    expect(mockSettingsStore.saveSection).toHaveBeenLastCalledWith(
      'gatewayAutoStart',
      { include: ['default', 'reviewer'] },
      { restart: false },
    )
  })
})
