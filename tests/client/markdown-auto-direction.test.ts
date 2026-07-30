// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}" />` })),
  },
}))

vi.mock('@/utils/desktop-browser', () => ({
  openUrlInDesktopBrowser: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: { props: ['show', 'width'], template: '<div v-if="show"><slot /></div>' },
  NDrawerContent: { props: ['title', 'closable', 'bodyContentStyle'], template: '<section><slot /></section>' },
  NSpin: { props: ['show'], template: '<div><slot /></div>' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

async function render(content: string): Promise<string> {
  const wrapper = mount(MarkdownRenderer, { props: { content } })
  await nextTick()
  return wrapper.html()
}

describe('message direction follows the message, not the interface', () => {
  it('marks every block so its own text decides the direction', async () => {
    const html = await render([
      'خلصت الجزء الأول ورفعته على السيرفر.',
      '',
      '## عنوان',
      '',
      '- عنصر أول',
      '- عنصر ثانٍ',
      '',
      '> اقتباس',
    ].join('\n'))

    expect(html).toContain('<p dir="auto">')
    expect(html).toContain('<h2 dir="auto"')
    expect(html).toContain('<li dir="auto">')
    expect(html).toContain('<blockquote dir="auto">')
  })

  it('applies to English text the same way, so a mixed conversation stays readable', async () => {
    const html = await render('The deploy finished.\n\nتم النشر بنجاح.')
    expect(html.match(/<p dir="auto">/g)?.length).toBe(2)
  })

  it('carries the attribute on the container itself', async () => {
    const wrapper = mount(MarkdownRenderer, { props: { content: 'مرحبا' } })
    await nextTick()
    expect(wrapper.find('.markdown-body').attributes('dir')).toBe('auto')
  })

  it('keeps code left-to-right inside a right-to-left message', async () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/MarkdownRenderer.vue', 'utf8')
    // A snippet inside an Arabic sentence must not be mirrored, so the rule is
    // in CSS rather than left to the browser's bidi guess.
    expect(source).toMatch(/pre,\s*\n\s*code,[\s\S]*?direction: ltr;/)
    expect(source).toContain('unicode-bidi: isolate;')
  })

  it('does not leave a physical alignment in table cells', async () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/MarkdownRenderer.vue', 'utf8')
    expect(source).not.toContain('text-align: left;')
  })
})

describe('user text elsewhere in the chat', () => {
  it('lets the composer show what is being typed in its own direction', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatInput.vue', 'utf8')
    expect(source).toContain('class="input-textarea"')
    expect(source).toContain('dir="auto"')
  })

  it('lets a conversation title in the list read in its own direction', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/SessionListItem.vue', 'utf8')
    expect(source).toContain('<span class="session-item-title" dir="auto">')
  })
})
