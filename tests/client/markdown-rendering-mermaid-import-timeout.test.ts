// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('mermaid', () => new Promise(() => {}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

async function flushMermaidRender(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

describe('MarkdownRenderer Mermaid import timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls back to copyable code when the mermaid dynamic import never settles', async () => {
    vi.useFakeTimers()

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await nextTick()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_001)
    await flushMermaidRender()

    expect(wrapper.find('.mermaid-loading').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('flowchart TD')
  })
})
