// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  sessionReset: { mode: 'both', idle_minutes: 60, at_hour: 0 },
  sessionTitleGeneration: { enabled: true, use_chat_model: true, provider: '', model: '', prompt: '' },
  approvals: { mode: 'manual' },
  saveSection: vi.fn(),
}))

const mockPrefsStore = vi.hoisted(() => ({
  humanOnly: true,
  setHumanOnly: vi.fn((value: boolean) => {
    mockPrefsStore.humanOnly = value
  }),
}))

const mockAppStore = vi.hoisted(() => ({
  modelGroups: [],
  profileModelGroups: [
    {
      profile: 'default',
      default_provider: 'openai-api',
      default: 'gpt-4o',
      groups: [
        { provider: 'openai-api', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini'] },
        { provider: 'anthropic', label: 'Anthropic', models: ['claude-3.5-sonnet'] },
      ],
    },
  ],
  loadModels: vi.fn(),
  displayModelName: (model: string) => model,
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/stores/hermes/session-browser-prefs', () => ({
  useSessionBrowserPrefsStore: () => mockPrefsStore,
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
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import SessionSettings from '@/components/hermes/settings/SessionSettings.vue'

function mountSessionSettings() {
  return mount(SessionSettings, {
    global: {
      stubs: {
        SettingRow: {
          props: ['label', 'hint'],
          template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div v-if="hint" class="setting-row-hint">{{ hint }}</div><slot /></div>',
        },
        NModal: {
          props: ['show'],
          emits: ['update:show'],
          template: '<div v-if="show" class="n-modal"><slot /></div>',
        },
        NButton: {
          props: ['disabled'],
          emits: ['click'],
          template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
        },
        NInput: {
          props: ['value'],
          emits: ['update:value'],
          template: '<textarea :value="value" @input="$emit(\'update:value\', ($event.target as HTMLTextAreaElement).value)" />',
        },
        NSelect: {
          props: ['value', 'options', 'disabled'],
          emits: ['update:value'],
          template: `
            <div class="n-select">
              <span class="select-value">{{ value }}</span>
              <button v-for="option in options" :key="option.value" type="button" class="select-option" @click="$emit('update:value', option.value)">{{ option.label }}</button>
            </div>
          `,
        },
        NSwitch: {
          props: ['value'],
          emits: ['update:value'],
          template: '<button type="button" class="n-switch" @click="$emit(\'update:value\', !value)">{{ value ? \'on\' : \'off\' }}</button>',
        },
      },
    },
  })
}

describe('SessionSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefsStore.humanOnly = true
    mockSettingsStore.sessionTitleGeneration = { enabled: true, use_chat_model: true, provider: '', model: '', prompt: '' }
  })

  it('surfaces the human-only preference in the Session tab', async () => {
    const wrapper = mountSessionSettings()

    expect(wrapper.text()).toContain('settings.session.liveMonitorHumanOnly')
    expect(wrapper.text()).toContain('Session titles')

    const toggles = wrapper.findAll('.n-switch')
    expect(toggles.length).toBe(1)
    await toggles[0].trigger('click')
    await Promise.resolve()

    expect(mockPrefsStore.setHumanOnly).toHaveBeenCalledWith(false)
  })

  it('shows one compact session titles row and moves details into Configure', async () => {
    const wrapper = mountSessionSettings()

    expect(wrapper.text()).toContain('Session titles')
    expect(wrapper.text()).toContain('AI-generated')
    expect(wrapper.find('[data-testid="session-title-configure"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Configure AI-generated session titles')
    expect(wrapper.text()).not.toContain('title_generation')
    expect(wrapper.text()).not.toContain('Base prompt')

    await wrapper.find('[data-testid="session-title-configure"]').trigger('click')

    expect(wrapper.text()).toContain('First message')
    expect(wrapper.text()).toContain('Use the first words of the first user message.')
    expect(wrapper.text()).toContain('AI-generated')
    expect(wrapper.text()).toContain('Generate a short title after the first assistant reply.')
    expect(wrapper.text()).toContain('Same as chat model')
    expect(wrapper.text()).toContain('Custom model')
    expect(wrapper.text()).toContain('Default prompt')
  })

  it('saves first-message mode from the configure dialog', async () => {
    const wrapper = mountSessionSettings()

    await wrapper.find('[data-testid="session-title-configure"]').trigger('click')
    await wrapper.find('[data-testid="session-title-mode-first"]').trigger('click')
    await wrapper.find('[data-testid="session-title-save"]').trigger('click')
    await Promise.resolve()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('session_title_generation', {
      enabled: false,
      use_chat_model: true,
      prompt: expect.any(String),
    })
  })

  it('saves a custom title model from the configure dialog', async () => {
    mockSettingsStore.sessionTitleGeneration = {
      enabled: true,
      use_chat_model: false,
      provider: 'anthropic',
      model: 'claude-3.5-sonnet',
      prompt: '',
    }
    const wrapper = mountSessionSettings()

    await wrapper.find('[data-testid="session-title-configure"]').trigger('click')
    await wrapper.find('[data-testid="session-title-save"]').trigger('click')
    await Promise.resolve()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('session_title_generation', {
      enabled: true,
      use_chat_model: false,
      provider: 'anthropic',
      model: 'claude-3.5-sonnet',
      prompt: expect.any(String),
    })
  })
})
