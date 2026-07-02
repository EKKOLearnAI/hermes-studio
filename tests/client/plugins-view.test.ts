// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }],
  fetchProfiles: vi.fn(),
}))

const fetchPluginsMock = vi.hoisted(() => vi.fn())
const setPluginEnabledMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/api/hermes/plugins', () => ({
  fetchPlugins: fetchPluginsMock,
  setPluginEnabled: setPluginEnabledMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, any>) => values?.name ? `${key}:${values.name}` : key,
    te: () => false,
  }),
}))

vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ template: '<div><slot /></div>' }),
  NButton: defineComponent({
    props: { loading: Boolean },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="loading" @click="$emit(\'click\')"><slot /></button>',
  }),
  NEmpty: defineComponent({ props: ['description'], template: '<div>{{ description }}</div>' }),
  NInput: defineComponent({
    props: ['value', 'placeholder'],
    emits: ['update:value'],
    template: '<input :value="value" :placeholder="placeholder" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSelect: defineComponent({
    props: ['value', 'options', 'placeholder'],
    emits: ['update:value'],
    template: '<select><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NSpin: defineComponent({ template: '<div />' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useMessage: () => messageMock,
}))

import PluginsView from '@/views/hermes/PluginsView.vue'

describe('PluginsView management actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profilesStoreMock.activeProfileName = 'default'
    profilesStoreMock.profiles = [{ name: 'default' }]
    fetchPluginsMock.mockResolvedValue({
      plugins: [{
        key: 'local-plugin',
        name: 'local-plugin',
        kind: 'standalone',
        source: 'user',
        configStatus: 'not-enabled',
        effectiveStatus: 'inactive',
        version: '',
        description: '',
        author: '',
        path: '/tmp/local-plugin',
        providesTools: [],
        providesHooks: [],
        requiresEnv: [],
      }],
      warnings: [],
      metadata: null,
    })
    setPluginEnabledMock.mockResolvedValue({ key: 'local-plugin', enabled: true })
  })

  it('enables manageable standalone plugins and refreshes the inventory', async () => {
    const wrapper = mount(PluginsView)
    await flushPromises()

    const buttons = wrapper.findAll('.n-button-stub')
    const enableButton = buttons.find(button => button.text() === 'common.enable')
    expect(enableButton).toBeTruthy()

    await enableButton!.trigger('click')
    await flushPromises()

    expect(setPluginEnabledMock).toHaveBeenCalledWith('local-plugin', true)
    expect(messageMock.success).toHaveBeenCalledWith('plugins.enableSuccess:local-plugin')
    expect(fetchPluginsMock).toHaveBeenCalledTimes(2)
  })

  it('leaves bundled plugins read-only', async () => {
    fetchPluginsMock.mockResolvedValueOnce({
      plugins: [{
        key: 'bundled-plugin',
        name: 'bundled-plugin',
        kind: 'standalone',
        source: 'bundled',
        configStatus: 'auto',
        effectiveStatus: 'auto-active',
        version: '',
        description: '',
        author: '',
        path: '',
        providesTools: [],
        providesHooks: [],
        requiresEnv: [],
      }],
      warnings: [],
      metadata: null,
    })

    const wrapper = mount(PluginsView)
    await flushPromises()

    expect(wrapper.text()).toContain('plugins.managedElsewhere')
    expect(wrapper.text()).not.toContain('common.disable')
  })
})
