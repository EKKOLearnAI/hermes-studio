// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import AuroraStatusPanel from '@/components/hermes/aurora/AuroraStatusPanel.vue'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'
import { useAppStore } from '@/stores/hermes/app'
import { useAuroraWorkingMemoryStore, WORKING_MEMORY_CONTEXT_MARKER } from '@/stores/hermes/working-memory'

describe('Aurora v0.1 Control neural event HUD', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    auroraEventBus.clearTimeline()
  })

  it('renders IPC events and lets the user pause/clear Working Memory context', async () => {
    const appStore = useAppStore()
    const workingMemoryStore = useAuroraWorkingMemoryStore()
    appStore.setAuroraStatusOpen(true)
    workingMemoryStore.setBrowserContext({
      url: 'https://example.com/macro',
      title: 'Macro Article',
      source: 'browser',
      topic: 'Macro Article',
      excerpt: 'A visible page excerpt is available for contextual commands.',
    })
    auroraEventBus.publish('PAGE_ANALYZED', {
      url: 'https://example.com/macro',
      title: 'Macro Article',
      source: 'browser',
      topic: 'Macro Article',
      analyzedAt: '2026-05-31T02:10:00.000Z',
    })

    const wrapper = mount(AuroraStatusPanel, {
      global: {
        stubs: {
          Transition: false,
        },
      },
    })

    await flushPromises()
    expect(wrapper.text()).toContain('Neural Events')
    expect(wrapper.text()).toContain('PAGE_ANALYZED')
    expect(wrapper.text()).toContain('Macro Article')
    expect(wrapper.text()).toContain('Context Lock On')
    expect(workingMemoryStore.enrichPrompt('Summarize this')).toContain(WORKING_MEMORY_CONTEXT_MARKER)

    workingMemoryStore.setContextLockEnabled(false)
    await flushPromises()
    expect(wrapper.text()).toContain('Context RAM paused')
    expect(workingMemoryStore.enrichPrompt('Summarize this')).toBe('Summarize this')

    workingMemoryStore.setContextLockEnabled(true)
    workingMemoryStore.clearAllContext()
    await flushPromises()
    expect(wrapper.text()).toContain('No active on-screen context captured yet.')
  })
})
