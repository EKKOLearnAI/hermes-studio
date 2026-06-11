// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockFetchPendingWrites = vi.hoisted(() => vi.fn())

const mockSettingsStore = vi.hoisted(() => ({
  sessionReset: { mode: 'both', idle_minutes: 60, at_hour: 0 },
  approvals: { mode: 'manual' },
  memory: { write_approval: false },
  skills: { write_approval: true },
  updateLocal: vi.fn((section: string, values: Record<string, any>) => {
    Object.assign((mockSettingsStore as any)[section], values)
  }),
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

vi.mock('@/api/hermes/write-gate', () => ({
  fetchPendingWrites: mockFetchPendingWrites,
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
    mockSettingsStore.memory.write_approval = false
    mockSettingsStore.skills.write_approval = true
    mockFetchPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: true })
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
          NButton: { template: '<button><slot /></button>' },
          NTag: { template: '<span><slot /></span>' },
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
    await flushPromises()

    expect(wrapper.text()).toContain('settings.session.liveMonitorHumanOnly')

    const toggles = wrapper.findAll('.n-switch')
    expect(toggles.length).toBe(4)
    const humanOnlyToggle = toggles[3]

    await humanOnlyToggle.trigger('click')
    await Promise.resolve()

    expect(mockPrefsStore.setHumanOnly).toHaveBeenCalledWith(false)
  })

  it('saves write approval toggles to memory and skills config sections', async () => {
    const wrapper = mount(SessionSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><slot /></div>',
          },
          NSelect: true,
          NInputNumber: true,
          NButton: { template: '<button><slot /></button>' },
          NTag: { template: '<span><slot /></span>' },
          NSwitch: {
            props: ['value'],
            emits: ['update:value'],
            template: '<button class="n-switch" @click="$emit(\'update:value\', !value)"></button>',
          },
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('settings.session.memoryWriteApproval')
    expect(wrapper.text()).toContain('settings.session.skillsWriteApproval')

    const toggles = wrapper.findAll('.n-switch')
    await toggles[1].trigger('click')
    await Promise.resolve()
    await toggles[2].trigger('click')
    await Promise.resolve()

    expect(mockSettingsStore.updateLocal).toHaveBeenCalledWith('memory', { write_approval: true })
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('memory', { write_approval: true })
    expect(mockSettingsStore.updateLocal).toHaveBeenCalledWith('skills', { write_approval: false })
    expect(mockSettingsStore.saveSection).toHaveBeenCalledWith('skills', { write_approval: false })
  })

  it('hides write approval toggles when Hermes Agent does not support them', async () => {
    mockFetchPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: false })

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
            template: '<button class="n-switch" @click="$emit(\'update:value\', !value)"></button>',
          },
        },
      },
    })

    await flushPromises()

    expect(wrapper.text()).not.toContain('settings.session.memoryWriteApproval')
    expect(wrapper.text()).not.toContain('settings.session.skillsWriteApproval')
  })
})
