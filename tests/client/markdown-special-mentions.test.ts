// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  }
})

vi.mock('@/api/hermes/download', () => ({
  downloadFile: vi.fn(),
  getDownloadUrl: vi.fn((path: string) => `/download?path=${encodeURIComponent(path)}`),
}))

vi.mock('@/components/hermes/chat/mermaidRenderer', () => ({
  renderMermaidDiagram: vi.fn(),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer special mentions', () => {
  it('highlights @all as a mention when provided by group chat', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '@all, please compare options',
        mentionNames: ['all', 'Alice'],
      },
    })

    expect(wrapper.find('.mention-highlight').text()).toBe('@all')
  })

  it('highlights @all at the end of rendered paragraphs and after opening punctuation', () => {
    for (const content of ['@all', 'please compare @all', '(@all)']) {
      const wrapper = mount(MarkdownRenderer, {
        props: {
          content,
          mentionNames: ['all', 'Alice'],
        },
      })

      expect(wrapper.find('.mention-highlight').text()).toBe('@all')
    }
  })

  it('does not highlight @alligator as @all', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '@alligator should stay plain',
        mentionNames: ['all'],
      },
    })

    expect(wrapper.find('.mention-highlight').exists()).toBe(false)
  })
})
