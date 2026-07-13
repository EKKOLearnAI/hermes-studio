// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const fetchScaleSyncSettings = vi.hoisted(() => vi.fn())
const updateScaleSyncSettings = vi.hoisted(() => vi.fn())
const runScaleSync = vi.hoisted(() => vi.fn())
const profilesStore = vi.hoisted(() => ({ activeProfileName: 'default' }))

vi.mock('@/api/hermes/health-state', () => ({
  fetchScaleSyncSettings,
  updateScaleSyncSettings,
  runScaleSync,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    props: { loading: Boolean },
    template: '<button><slot /></button>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: String, size: String, autocomplete: String, type: String, placeholder: String },
    template: '<input :value="value" />',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    inheritAttrs: false,
    props: { value: String, options: Array, size: String },
    template: '<select><option>{{ value }}</option></select>',
  }),
  NSwitch: defineComponent({
    name: 'NSwitch',
    inheritAttrs: false,
    props: { value: Boolean },
    template: '<input type="checkbox" :checked="value" />',
  }),
}))

import XiaomiHealthSettings from '@/components/hermes/settings/XiaomiHealthSettings.vue'

describe('XiaomiHealthSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchScaleSyncSettings.mockResolvedValue({
      enabled: true,
      source: 'xiaomihome',
      username: 'xiaomi-user',
      hasPassword: true,
      passwordMasked: '********',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: 'C:\\tools\\scaleconnect.exe',
      configured: true,
    })
  })

  it('renders Xiaomi scale sync settings from the active profile', async () => {
    const wrapper = mount(XiaomiHealthSettings)
    await flushPromises()

    expect(fetchScaleSyncSettings).toHaveBeenCalledWith('default')
    expect(wrapper.find('[data-test="xiaomi-health-settings"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('health.scaleSync.settingsTitle')
    expect(wrapper.text()).toContain('health.scaleSync.ready')
    expect(wrapper.text()).toContain('health.scaleSync.runNow')
  })
})
