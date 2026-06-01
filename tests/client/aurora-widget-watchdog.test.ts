// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/hermes/aurora/generated-widgets', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  const BrokenWidget = vue.defineComponent({
    name: 'BrokenWidget',
    setup() {
      return () => {
        throw new Error('missingWidgetState is not defined')
      }
    },
  })

  return {
    normalizeGeneratedWidgetName: (input: string) => input.replace(/\.vue$/i, ''),
    listGeneratedWidgets: () => [{
      widgetName: 'BrokenWidget',
      componentPath: 'packages/client/src/components/generated/BrokenWidget.vue',
      modulePath: '../../../components/generated/BrokenWidget.vue',
      loader: async () => ({ default: BrokenWidget }),
    }],
    findGeneratedWidget: (widgetName: string) => widgetName === 'BrokenWidget'
      ? {
          widgetName: 'BrokenWidget',
          componentPath: 'packages/client/src/components/generated/BrokenWidget.vue',
          modulePath: '../../../components/generated/BrokenWidget.vue',
          loader: async () => ({ default: BrokenWidget }),
        }
      : null,
  }
})

import WidgetRenderer from '@/components/hermes/aurora/overlays/WidgetRenderer.vue'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'
import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'

describe('Aurora generated widget runtime watchdog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    auroraEventBus.clearTimeline()
  })

  it('catches generated widget runtime errors, keeps Aurora mounted, and queues a fix intent', async () => {
    const wrapper = mount(WidgetRenderer, {
      props: {
        widgetName: 'BrokenWidget',
      },
    })
    await flushPromises()
    await flushPromises()

    const vibeCodingStore = useVibeCodingStore()

    expect(wrapper.text()).toContain('Widget rendering failed or not found')
    expect(vibeCodingStore.selfHealingFixQueue[0]).toMatchObject({
      widgetName: 'BrokenWidget',
      componentPath: 'packages/client/src/components/generated/BrokenWidget.vue',
      errorMessage: 'missingWidgetState is not defined',
    })
    expect(vibeCodingStore.selfHealingFixQueue[0].prompt).toContain('Fix generated widget BrokenWidget')
    expect(auroraEventBus.timeline.value[0]).toMatchObject({
      type: 'GENERATED_WIDGET_RUNTIME_ERROR',
      payload: {
        widgetName: 'BrokenWidget',
        message: 'missingWidgetState is not defined',
      },
    })
    wrapper.unmount()
  })
})
