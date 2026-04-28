// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  sessionReset: { mode: 'both', idle_minutes: 60, at_hour: 0 },
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
    const wrapper = mount(SessionSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><slot /></div>',
          },
          NSelect: true,
          NInputNumber: true,
        },
      },
    })

    expect(wrapper.text()).toContain('settings.session.liveMonitorHumanOnly')

    const toggle = wrapper.find('.n-switch')
    expect(toggle.exists()).toBe(true)

    await toggle.trigger('click')
    await Promise.resolve()

    expect(mockPrefsStore.setHumanOnly).toHaveBeenCalledWith(false)
  })
})
