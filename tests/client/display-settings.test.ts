// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { MAX_CHAT_INPUT_HEIGHT, MIN_CHAT_INPUT_HEIGHT } from '@/utils/chat-input-height'

const mockSettingsStore = vi.hoisted(() => ({
  display: {
    streaming: true,
    compact: false,
    show_reasoning: true,
    show_cost: false,
    inline_diffs: true,
    chat_input_height: 160,
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
    NInputNumber: defineComponent({
      props: {
        value: { type: Number, required: false, default: null },
        min: { type: Number, required: false, default: 0 },
        max: { type: Number, required: false, default: 1000 },
      },
      emits: ['update:value'],
      setup(props, { emit }) {
        return () => h('input', {
          class: 'n-input-number',
          type: 'number',
          value: props.value ?? '',
          onInput: (event: Event) => {
            const value = (event.target as HTMLInputElement).value
            emit('update:value', value === '' ? null : Number(value))
          },
        })
      },
    }),
    NButton: defineComponent({
      emits: ['click'],
      setup(_props, { emit, slots }) {
        return () => h('button', { type: 'button', onClick: () => emit('click') }, slots.default?.())
      },
    }),
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import DisplaySettings from '@/components/hermes/settings/DisplaySettings.vue'

describe('DisplaySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.display.chat_input_height = 160
    mockSettingsStore.saveSection.mockResolvedValue(undefined)
  })

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

  it('saves a clamped chat input height and can reset back to automatic height', async () => {
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

    expect(wrapper.text()).toContain('settings.display.chatInputHeight')

    const input = wrapper.get('.n-input-number')
    await input.setValue(String(MAX_CHAT_INPUT_HEIGHT + 100))
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: MAX_CHAT_INPUT_HEIGHT })

    await input.setValue(String(MIN_CHAT_INPUT_HEIGHT - 100))
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: MIN_CHAT_INPUT_HEIGHT })

    const resetButton = wrapper.findAll('button').find(button => button.text() === 'common.reset')
    expect(resetButton).toBeTruthy()
    await resetButton!.trigger('click')
    await flushPromises()

    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('display', { chat_input_height: null })
  })
})
