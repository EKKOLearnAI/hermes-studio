// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  sessionReset: { mode: 'both', idle_minutes: 60, at_hour: 0 },
  approvals: { mode: 'manual' },
  saveSection: vi.fn(),
}))

const mockPrefsStore = vi.hoisted(() => ({
  humanOnly: true,
  setHumanOnly: vi.fn((value: boolean) => {
    mockPrefsStore.humanOnly = value
  }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
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

describe('SessionSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefsStore.humanOnly = true
  })

  it('surfaces the human-only preference in the Session tab', async () => {
    let emittedValue: boolean | undefined
    const wrapper = mount(SessionSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><slot /></div>',
          },
          NSelect: true,
          NInputNumber: true,
          NSwitch: {
            props: ['value'],
            emits: ['update:value'],
            template: '<div class="n-switch" @click="$emit(\'update:value\', !value)"></div>',
            setup(props: any, { emit }: any) {
              return {
                onClick: () => {
                  emittedValue = !props.value
                  emit('update:value', emittedValue)
                },
              }
            },
          },
        },
      },
    })

    expect(wrapper.text()).toContain('settings.session.liveMonitorHumanOnly')

    const toggles = wrapper.findAll('.n-switch')
    expect(toggles.length).toBe(2)
    const humanOnlyToggle = toggles[1]

    await humanOnlyToggle.trigger('click')
    await Promise.resolve()

    expect(mockPrefsStore.setHumanOnly).toHaveBeenCalledWith(false)
  })
})
