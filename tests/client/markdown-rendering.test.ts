// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

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

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('highlights vue fenced blocks instead of rendering them as plain text', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```vue\n<template><div>Hello</div></template>\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('vue')
    expect(wrapper.find('code.hljs').html()).toContain('hljs-tag')
  })

  it('keeps shell-session fences on the shell grammar', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```shell\n$ ls\nfoo.txt\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('shell')
    expect(wrapper.find('code.hljs').html()).toContain('hljs-meta')
  })

  it('still highlights long supported code fences', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `\`\`\`json\n${JSON.stringify({ content: 'x'.repeat(2500), ok: true })}\n\`\`\``,
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('json')
    expect(wrapper.find('code.hljs').html()).toMatch(/hljs-(attr|string|punctuation)/)
  })

  it('falls back to plain escaped text when a fence language is unsupported', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```foobar\n{"answer":42,"ok":true}\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('foobar')
    expect(wrapper.find('code.hljs').findAll('span')).toHaveLength(0)
    expect(wrapper.find('code.hljs').text()).toContain('{"answer":42,"ok":true}')
  })

  it('keeps unlabeled code fences as plain text instead of guessing a grammar', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```\nINFO Starting server\nConnected to 127.0.0.1\nDone\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('text')
    expect(wrapper.find('code.hljs').findAll('span')).toHaveLength(0)
    expect(wrapper.find('code.hljs').text()).toContain('INFO Starting server')
  })

  it('copies code through the delegated click handler', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    const expected = wrapper.find('code.hljs').element.textContent ?? ''
    await wrapper.find('[data-copy-code="true"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(expected)
  })
})
