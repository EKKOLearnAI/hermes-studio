// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  display: {
    streaming: true,
    compact: false,
    show_reasoning: true,
    show_cost: false,
    inline_diffs: true,
    bell_on_complete: false,
    notify_on_complete: false,
    busy_input_mode: 'interrupt',
  },
  saveSection: vi.fn(),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    brightness: 'system',
    setBrightness: vi.fn(),
  }),
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

import DisplaySettings from '@/components/hermes/settings/DisplaySettings.vue'

describe('DisplaySettings', () => {
  it('does not expose the unwired busy input mode toggle', () => {
    const wrapper = mount(DisplaySettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><div class="setting-row-hint">{{ hint }}</div><slot /></div>',
          },
          NSelect: true,
          NSwitch: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('settings.display.busyInputMode')
    expect(wrapper.text()).not.toContain('settings.display.busyInputModeHint')
  })
})
