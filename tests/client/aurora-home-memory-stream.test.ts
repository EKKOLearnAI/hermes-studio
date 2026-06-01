// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AuroraOperatingLayer from '@/components/hermes/aurora/AuroraOperatingLayer.vue'
import { getQuantLabMiroFishMemoryRecords } from '@/api/hermes/quant-lab'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAppStore } from '@/stores/hermes/app'
import { i18n, switchLocale } from '@/i18n'

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

vi.mock('@/api/client', () => ({
  clearApiKey: vi.fn(),
}))

vi.mock('@/api/hermes/profiles', () => ({
  fetchAuroraProfilePreferences: vi.fn(async () => ({
    storage: 'default',
    preferences: {
      desktop: { pinnedApps: [] },
      updatedAt: '2026-05-30T00:00:00.000Z',
    },
  })),
  updateAuroraProfilePreferences: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/api/aurora/intent-audit', () => ({
  writeAuroraIntentAuditRecord: vi.fn(async record => ({ ok: true, record, count: 1 })),
  fetchAuroraIntentAudit: vi.fn(async () => ({
    generatedAt: '2026-05-30T00:00:00.000Z',
    storage: 'server',
    records: [],
  })),
  clearAuroraIntentAudit: vi.fn(async () => ({ ok: true, count: 0 })),
}))

vi.mock('@/api/hermes/quant-lab', () => ({
  getQuantLabMiroFishMemoryRecords: vi.fn(),
}))

const getMemoryRecordsMock = vi.mocked(getQuantLabMiroFishMemoryRecords)

function memoryRecord(index: number) {
  return {
    id: `memory-${index}`,
    fileName: `memory-${index}.md`,
    path: `/tmp/MiroFish_Records/memory-${index}.md`,
    relativePath: `MiroFish_Records/memory-${index}.md`,
    title: `Aurora verdict ${index}`,
    question: `推演 Aurora OS 第 ${index} 段策略`,
    date: `2026-05-30T0${index}:00:00.000Z`,
    finalVerdict: index === 1 ? 'SYNTH PILOT · favorable 62%' : 'SYNTH HOLD · pilot 31%',
    summary: 'Recent MiroFish memory.',
    source: 'aurora-universal-brain',
    tags: ['aurora', 'mirofish'],
    size: 1024,
    updatedAt: `2026-05-30T0${index}:00:00.000Z`,
  }
}

describe('Aurora homepage Memory Stream', () => {
  beforeEach(() => {
    window.localStorage.clear()
    switchLocale('en-US')
    setActivePinia(createPinia())
    getMemoryRecordsMock.mockReset()
    getMemoryRecordsMock.mockResolvedValue({
      ok: true,
      path: '/tmp/MiroFish_Records',
      relativePath: 'MiroFish_Records',
      directories: ['MiroFish_Records'],
      updatedAt: '2026-05-30T09:00:00.000Z',
      records: [1, 2, 3, 4, 5].map(memoryRecord),
    })
  })

  it('renders recent Obsidian verdicts and opens MiroFish rehydration App Mode', async () => {
    const wrapper = mount(AuroraOperatingLayer, {
      global: {
        plugins: [i18n],
        stubs: {
          ResultOverlay: true,
          AppWindowOverlay: true,
          VibeCodingOverlay: true,
        },
      },
      slots: {
        default: '<div class="chat-shell-stub"></div>',
      },
    })

    await flushPromises()

    expect(getMemoryRecordsMock).toHaveBeenCalledWith(4)
    expect(wrapper.find('.aurora-trust-rail.memory-stream').text()).toContain('Neural Memory')
    expect(wrapper.findAll('.memory-stream-item')).toHaveLength(4)
    expect(wrapper.text()).toContain('推演 Aurora OS 第 1 段策略')
    expect(wrapper.text()).not.toContain('推演 Aurora OS 第 5 段策略')
    expect(wrapper.find('.memory-stream-preview').text()).toContain('Recent MiroFish memory.')

    await wrapper.find('.memory-stream-item').trigger('click')
    const appWindowStore = useAuroraAppWindowStore()

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish')
    expect(appWindowStore.activePayload).toMatchObject({
      initialView: 'graph',
      launchContext: {
        source: 'aurora-memory-stream',
        topic: '推演 Aurora OS 第 1 段策略',
        memoryRecordId: 'memory-1',
        memoryRecordPath: 'MiroFish_Records/memory-1.md',
      },
    })

    wrapper.unmount()
  })

  it('keeps the idle dock minimal, expandable, and able to reset to the Aurora desktop', async () => {
    const wrapper = mount(AuroraOperatingLayer, {
      global: {
        plugins: [i18n],
        stubs: {
          ResultOverlay: true,
          AppWindowOverlay: true,
          VibeCodingOverlay: true,
        },
      },
      slots: {
        default: '<div class="chat-shell-stub"></div>',
      },
    })

    await flushPromises()

    const toolsDock = wrapper.find('[aria-label="Aurora Tools Dock"]')
    const toolLabels = toolsDock.findAll('.tool-chip strong').map(label => label.text())
    expect(toolLabels).toEqual(['Files', 'Calendar', 'Mail', 'Memory', 'Chart', 'Sandbox'])
    expect(toolsDock.text()).not.toContain('LifeOS')
    expect(toolsDock.text()).not.toContain('Quant')

    await wrapper.find('.aurora-dock-handle').trigger('click')
    await flushPromises()
    expect(wrapper.find('[aria-label="Expanded Aurora App Launcher"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Expanded Aurora App Launcher"]').text()).toContain('Memory')
    expect(wrapper.find('[aria-label="Expanded Aurora App Launcher"]').text()).not.toContain('LifeOS')
    expect(wrapper.find('[aria-label="Expanded Aurora App Launcher"]').text()).not.toContain('Quant')

    const appStore = useAppStore()
    appStore.setAdvancedConsoleOpen(true)
    const previousRequestId = appStore.auroraDesktopRequestId
    await wrapper.find('[aria-label="Return to Aurora Desktop"]').trigger('click')

    expect(appStore.isAdvancedConsoleOpen).toBe(false)
    expect(appStore.auroraDesktopRequestId).toBe(previousRequestId + 1)
    expect(wrapper.find('[aria-label="Expanded Aurora App Launcher"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('toggles the Aurora shell between English and Traditional Chinese without reloading', async () => {
    const wrapper = mount(AuroraOperatingLayer, {
      global: {
        plugins: [i18n],
        stubs: {
          ResultOverlay: true,
          AppWindowOverlay: true,
          VibeCodingOverlay: true,
        },
      },
      slots: {
        default: '<div class="chat-shell-stub"></div>',
      },
    })

    await flushPromises()

    expect(wrapper.find('.language-glyph').text()).toBe('EN')
    expect(wrapper.find('.aurora-trust-rail.memory-stream').text()).toContain('Recent Verdicts')

    await wrapper.find('.language-chip').trigger('click')
    await flushPromises()

    expect(window.localStorage.getItem('hermes_locale')).toBe('zh-TW')
    expect(wrapper.find('.language-glyph').text()).toBe('繁')
    expect(wrapper.find('.aurora-trust-rail.memory-stream').text()).toContain('近期推演')
    expect(wrapper.find('[aria-label="Aurora 工具 Dock"]').exists()).toBe(true)

    switchLocale('en-US')
    wrapper.unmount()
  })
})
