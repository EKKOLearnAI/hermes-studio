// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('naive-ui', () => {
  const slotStub = (name: string) => ({ name, template: `<div><slot /></div>` })
  return {
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
    NDrawer: slotStub('NDrawer'),
    NDrawerContent: slotStub('NDrawerContent'),
    NSpin: slotStub('NSpin'),
  }
})

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

describe('omp generated-image assistant message render (reload shape)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []),
        speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      },
    })
  })

  it('renders an <img> for an assistant message whose content is only image markdown', async () => {
    const imagePath = '/home/agent/.hermes-web-ui/upload/default/omp-images/omp-x.png'
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: '70',
          role: 'assistant',
          content: `\n\n![generated image](${imagePath})\n`,
          timestamp: Date.now(),
        } satisfies Message,
      },
    })
    await wrapper.vm.$nextTick()
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    // src must be rewritten to the download endpoint
    expect(img.attributes('src')).toContain('/api/hermes/download')
    expect(img.attributes('src')).toContain(encodeURIComponent(imagePath))
  })

  it('renders text for the assistant follow-up message', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: '73',
          role: 'assistant',
          content: "Here's a cool emoji face — sunglasses, smug smile.",
          timestamp: Date.now(),
        } satisfies Message,
      },
    })
    await wrapper.vm.$nextTick()
    // typographer rewrites the straight apostrophe; assert on apostrophe-free text
    expect(wrapper.text()).toContain('cool emoji face — sunglasses, smug smile.')
  })
})
