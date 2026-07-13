// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => ({
    svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
  })),
}))

const downloadApiMock = vi.hoisted(() => ({
  downloadFile: vi.fn(() => Promise.resolve()),
  fetchFileText: vi.fn(() => Promise.resolve('preview content')),
  getDownloadUrl: vi.fn((path: string) => `http://test.local/api/hermes/download?path=${encodeURIComponent(path)}`),
}))

vi.mock('mermaid', () => ({
  default: mermaidMock,
}))

async function flushMermaidRender(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: {
    props: ['show', 'width'],
    template: '<div v-if="show" class="n-drawer-stub" :data-width="width"><slot /></div>',
  },
  NDrawerContent: {
    props: {
      title: { type: String, default: '' },
      closable: { type: Boolean, default: false },
      bodyContentStyle: { type: [Object, String], default: undefined },
    },
    template: '<section class="n-drawer-content-stub" :data-body-padding="bodyContentStyle && bodyContentStyle.padding"><header class="n-drawer-header-stub">{{ title }}<button v-if="closable" class="n-drawer-close-stub" @click="$emit(\'close\')">x</button></header><slot /></section>',
  },
  NSpin: {
    props: ['show'],
    template: '<div class="n-spin-stub"><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/api/hermes/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/hermes/download')>()
  return {
    ...actual,
    downloadFile: downloadApiMock.downloadFile,
    fetchFileText: downloadApiMock.fetchFileText,
    getDownloadUrl: downloadApiMock.getDownloadUrl,
  }
})

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    mermaidMock.initialize.mockClear()
    mermaidMock.render.mockClear()
    downloadApiMock.downloadFile.mockClear()
    downloadApiMock.fetchFileText.mockClear()
    downloadApiMock.getDownloadUrl.mockClear()
    mermaidMock.render.mockImplementation(async (id: string, source: string) => ({
      svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
    }))
    downloadApiMock.downloadFile.mockResolvedValue(undefined)
    downloadApiMock.fetchFileText.mockResolvedValue('preview content')
    downloadApiMock.getDownloadUrl.mockImplementation((path: string) => `http://test.local/api/hermes/download?path=${encodeURIComponent(path)}`)

    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
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

  it('renders outer markdown draft fences as markdown while preserving nested fenced examples', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '下面是可直接手动编辑的 PR draft。',
          '',
          '```md',
          '标题: fix(chat): 保留附件在同一聊天后续轮次的上下文',
          '',
          '## Summary',
          '',
          '附件上传后，首轮 `startRun()` 的 `input` 已包含上传文件引用:',
          '',
          '```md',
          '[File: screenshot.png](/uploaded/path)',
          '```',
          '',
          '但本地保存的用户消息只保留 UI 可见文本。',
          '',
          '## Fix',
          '- Preserve context.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('.code-lang').text()).toBe('md')
    expect(wrapper.find('code.hljs').text()).toContain('[File: screenshot.png](/uploaded/path)')
    expect(wrapper.find('.markdown-body').findAll('h2')).toHaveLength(2)
    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Summary')
    expect(wrapper.find('.markdown-body').text()).toContain('但本地保存的用户消息只保留 UI 可见文本。')
    expect(wrapper.find('.markdown-body').text()).toContain('Preserve context.')
  })

  it('keeps markdown examples with their own nested fences intact after unwrapping a draft fence', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Regression Coverage',
          '',
          '```md',
          '下面是一个 PR draft。',
          '',
          '```md',
          '[File: Screenshot.png](/tmp/example.png)',
          '```',
          '',
          '## Fix',
          '',
          '- 后续 heading 不应被截断。',
          '```',
          '',
          '## Local Verification',
          '',
          '- localhost renders after the example.',
          '```',
        ].join('\n'),
      },
    })

    const headings = wrapper.find('.markdown-body').findAll('h2').map(heading => heading.text())
    expect(headings).toEqual(['Regression Coverage', 'Local Verification'])
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)

    const codeText = wrapper.find('code.hljs').text()
    expect(codeText).toContain('下面是一个 PR draft。')
    expect(codeText).toContain('```md\n[File: Screenshot.png](/tmp/example.png)\n```')
    expect(codeText).toContain('## Fix')
    expect(codeText).toContain('- 后续 heading 不应被截断。')
    expect(wrapper.find('.markdown-body').text()).toContain('localhost renders after the example.')
  })

  it('keeps markdown examples with unlabeled nested fences intact', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Unlabeled Fence Example',
          '',
          '```md',
          '```',
          'plain nested block',
          '```',
          '```',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Unlabeled Fence Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('```\nplain nested block\n```')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('renders local mov links as inline video players', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[录屏2026-05-08 15.19.46.mov](/Users/ekko/Desktop/录屏2026-05-08%2015.19.46.mov)',
      },
    })

    const video = wrapper.find('video.markdown-video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toContain('/api/hermes/download?path=')
    const src = new URL(video.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov')
    expect(wrapper.find('.markdown-video-footer .att-name').text()).toBe('录屏2026-05-08 15.19.46.mov')
  })

  it('renders local mp3 links as inline audio players', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[song.mp3](/tmp/song.mp3)',
      },
    })

    const audio = wrapper.find('audio.markdown-audio')
    expect(audio.exists()).toBe(true)
    expect(audio.attributes('controls')).toBeDefined()
    expect(audio.attributes('preload')).toBe('metadata')
    expect(audio.attributes('src')).toContain('/api/hermes/download?path=')
    const src = new URL(audio.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/tmp/song.mp3')
    expect(wrapper.find('.markdown-audio-footer .att-name').text()).toBe('song.mp3')
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('renders MSYS-style Windows image paths through the download endpoint', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '![桌面截图](/c/Users/Administrator/Desktop/screenshot.png)',
      },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toContain('/api/hermes/download?path=')
    const src = new URL(img.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/c/Users/Administrator/Desktop/screenshot.png')
    expect(img.attributes('alt')).toBe('桌面截图')
  })

  it('downloads local text files when the file card download icon is clicked', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/tmp/notes.txt)',
      },
    })

    expect(wrapper.find('.markdown-file-card').exists()).toBe(true)
    expect(wrapper.find('.att-download-btn .att-download-icon').exists()).toBe(true)

    await wrapper.find('.att-download-btn').trigger('click')
    await Promise.resolve()

    expect(downloadApiMock.downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadApiMock.downloadFile).toHaveBeenCalledWith('/tmp/notes.txt', 'notes.txt')
    expect(downloadApiMock.fetchFileText).not.toHaveBeenCalled()
    expect(wrapper.find('.n-drawer-stub').exists()).toBe(false)
  })

  it('preserves the target extension when a local file link label has no suffix', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[下载报告](/tmp/report.md)',
      },
    })

    await wrapper.find('.att-download-btn').trigger('click')
    await Promise.resolve()

    expect(downloadApiMock.downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadApiMock.downloadFile).toHaveBeenCalledWith('/tmp/report.md', 'report.md')
  })

  it('opens text previews in a responsive drawer with a close control', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/tmp/notes.txt)',
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')
    await Promise.resolve()
    await nextTick()

    const drawer = wrapper.find('.n-drawer-stub')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-width')).toBe('min(800px, 100vw)')
    expect(drawer.find('.n-drawer-content-stub').attributes('data-body-padding')).toBe('0')
    expect(drawer.text()).toContain('download.contentDisplay')
    expect(downloadApiMock.fetchFileText).toHaveBeenCalledWith('/tmp/notes.txt', 'notes.txt')

    await drawer.find('.n-drawer-close-stub').trigger('click')
    await nextTick()

    expect(wrapper.find('.n-drawer-stub').exists()).toBe(false)
  })

  it('renders markdown file previews as markdown content', async () => {
    downloadApiMock.fetchFileText.mockResolvedValue('# Preview Title\n\n**bold text**')
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.md](/tmp/notes.md)',
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')
    await Promise.resolve()
    await nextTick()

    const drawer = wrapper.find('.n-drawer-stub')
    expect(drawer.exists()).toBe(true)
    expect(drawer.find('.text-preview-markdown').exists()).toBe(true)
    expect(drawer.find('.text-preview-body').exists()).toBe(false)
    expect(drawer.find('.text-preview-markdown h1').text()).toBe('Preview Title')
    expect(drawer.find('.text-preview-markdown strong').text()).toBe('bold text')
  })

  it('keeps tilde-fenced markdown examples with nested tilde fences intact', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Tilde Example',
          '',
          '~~~md',
          '~~~yaml',
          'ok: true',
          '~~~',
          '~~~',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Tilde Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('~~~yaml\nok: true\n~~~')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('keeps already-valid longer markdown example fences valid', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Longer Fence Example',
          '',
          '````md',
          '```ts',
          'const answer = 42',
          '```',
          '````',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Longer Fence Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('```ts\nconst answer = 42\n```')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('renders mermaid fences as diagrams instead of raw highlighted code', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```mermaid',
          'flowchart TD',
          'A[User] --> B[Web UI<br/>command]',
          '```',
          '',
          '具体 behavior:',
          '- Markdown below still renders.',
        ].join('\n'),
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
    }))
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^hermes-mermaid-/),
      expect.stringContaining('flowchart TD'),
    )
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(0)
    expect(wrapper.find('.markdown-body').find('ul').exists()).toBe(true)
  })

  it('renders mermaid inside repaired outer markdown draft fences', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Command flow',
          '',
          '```Mermaid title',
          'flowchart LR',
          'A --> B',
          '```',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    await flushMermaidRender()

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Command flow')
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^hermes-mermaid-/),
      expect.stringContaining('flowchart LR'),
    )
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('falls back to a copyable code block when mermaid rendering fails', async () => {
    mermaidMock.render.mockImplementationOnce((id: string) => {
      const errorContainer = document.createElement('div')
      errorContainer.id = `d${id}`
      errorContainer.textContent = 'Syntax error in text\nmermaid version 11.14.0'
      document.body.appendChild(errorContainer)
      return Promise.reject(new Error('bad diagram'))
    })
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nnot valid mermaid\n```',
      },
    })

    await flushMermaidRender()

    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('not valid mermaid')
    expect(wrapper.find('[data-copy-code="true"]').exists()).toBe(true)
    expect(document.body.textContent).not.toContain('Syntax error in text')
  })

  it('falls back to copyable code blocks when mermaid initialization fails', async () => {
    mermaidMock.initialize.mockImplementationOnce(() => {
      throw new Error('init failed')
    })

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('flowchart TD')
  })

  it('falls back without initializing mermaid when every pending diagram is oversized', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `\`\`\`mermaid\n${'A'.repeat(20_001)}\n\`\`\``,
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
  })

  it('falls back without initializing mermaid when every pending diagram is empty', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
  })

  it('falls back to copyable code when mermaid rendering never settles', async () => {
    vi.useFakeTimers()
    mermaidMock.render.mockImplementationOnce(() => new Promise(() => {}))

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

  it('does not load or render mermaid when the message has no mermaid block', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.code-lang').text()).toBe('ts')
  })

  it('does not let stale async mermaid renders mutate newer message content', async () => {
    let resolveRender: ((value: { svg: string }) => void) | undefined
    mermaidMock.render.mockImplementationOnce((id: string) => new Promise(resolve => {
      resolveRender = resolve
    }))

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await nextTick()
    await wrapper.setProps({ content: 'No diagram now.' })
    resolveRender?.({ svg: '<svg data-testid="stale-mermaid-svg"></svg>' })
    await flushMermaidRender()

    expect(wrapper.find('[data-testid="stale-mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.markdown-body').text()).toContain('No diagram now.')
  })

  it('renders inline latex math with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Pythagoras: $x^2 + y^2 = z^2$.',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.html()).toContain('x')
    expect(body.html()).toContain('z')
    expect(body.text()).not.toContain('$x^2 + y^2 = z^2$')
  })

  it('renders display latex math with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex-display').exists()).toBe(true)
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.text()).not.toContain('$$')
  })

  it('renders explicit latex fenced blocks with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```latex\n\\[\\text{Итог} = \\operatorname{Округление}\\!\\left(0.5\\,O_1 + 0.5\\,O_2\\right)\\]\n```',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex-display').exists()).toBe(true)
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.text()).not.toContain('```latex')
    expect(body.text()).toContain('Округление')
  })

  it('does not render latex inside ordinary fenced code blocks', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst formula = "$x^2 + y^2 = z^2$"\n```',
      },
    })

    expect(wrapper.find('.markdown-body').find('.katex').exists()).toBe(false)
    expect(wrapper.find('code.hljs').text()).toContain('$x^2 + y^2 = z^2$')
  })

  it('does not treat currency-like dollar text as latex math', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Price is $5 and $6 today.',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(false)
    expect(body.text()).toContain('Price is $5 and $6 today.')
  })

  it('does not render escaped dollar-delimited text as latex math', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Escaped: \\$x^2$',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(false)
    expect(body.text()).toContain('Escaped: $x^2$')
  })

  it('keeps rendering when latex syntax is invalid', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Before $\\notacommand{ after',
      },
    })

    expect(wrapper.find('.markdown-body').text()).toContain('Before')
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

  it('falls back to legacy clipboard copy when the Clipboard API is unavailable', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: false,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    await wrapper.find('[data-copy-code="true"]').trigger('click')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
