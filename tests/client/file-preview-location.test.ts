// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const previewMocks = vi.hoisted(() => ({
  fetchSessionWorkspaceFileBlob: vi.fn(),
  openHtmlInDesktopBrowser: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot name="header" /><slot /></div>' },
  NButton: { template: '<button><slot name="icon" /><slot /></button>' },
  NIcon: { template: '<i><slot /></i>' },
  NSpin: { template: '<div class="spin" />' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/utils/desktop-browser', () => ({
  openHtmlInDesktopBrowser: previewMocks.openHtmlInDesktopBrowser,
}))

vi.mock('@/api/studio/sessions', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/studio/sessions')>()
  return {
    ...actual,
    fetchSessionWorkspaceFileBlob: previewMocks.fetchSessionWorkspaceFileBlob,
  }
})

import { useFilesStore } from '@/stores/hermes/files'
import FilePreview from '@/components/hermes/files/FilePreview.vue'

describe('line-located file preview', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    previewMocks.fetchSessionWorkspaceFileBlob.mockReset()
    previewMocks.openHtmlInDesktopBrowser.mockReset()
    previewMocks.openHtmlInDesktopBrowser.mockResolvedValue(false)
  })

  it('renders, highlights, and reveals the requested source line range', async () => {
    const filesStore = useFilesStore()
    filesStore.previewFile = {
      path: 'server/src/heartbeat.release.ts',
      name: 'heartbeat.release.ts',
      size: 8_400,
      profile: null,
      workspaceSessionId: 'session-1',
      type: 'text',
      language: 'typescript',
      content: Array.from({ length: 600 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n'),
      startLine: 550,
      endLine: 552,
    }

    const wrapper = mount(FilePreview)
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.find('.preview-source-line[data-line="550"]').exists()).toBe(true)
    })

    const sourceLines = wrapper.findAll('.preview-source-line')
    expect(sourceLines.length).toBeGreaterThan(0)
    expect(sourceLines.length).toBeLessThan(100)
    const source = wrapper.get('.preview-source')
    expect(source.attributes('role')).toBe('region')
    expect(source.attributes('tabindex')).toBe('0')
    expect(source.attributes('aria-label')).toBe('files.preview: server/src/heartbeat.release.ts')
    expect(wrapper.get('.preview-location').text()).toBe('L550–552')
    expect(wrapper.get('.preview-source-line[data-line="550"]').text()).toContain('const line550 = 550')
    expect(wrapper.get('.preview-source-line[data-line="549"]').classes()).not.toContain('is-target-line')
    expect(wrapper.get('.preview-source-line[data-line="549"]').attributes('aria-current')).toBeUndefined()
    expect(wrapper.get('.preview-source-line[data-line="550"]').classes()).toContain('is-target-line')
    expect(wrapper.get('.preview-source-line[data-line="550"]').attributes('aria-current')).toBe('location')
    expect(wrapper.get('.preview-source-line[data-line="552"]').classes()).toContain('is-target-line')
    expect(wrapper.get('.preview-source-line[data-line="553"]').classes()).not.toContain('is-target-line')
    wrapper.unmount()
  })

  it('clamps out-of-range locations to the available source lines', async () => {
    const filesStore = useFilesStore()
    filesStore.previewFile = {
      path: 'short.ts',
      name: 'short.ts',
      size: 17,
      profile: null,
      workspaceSessionId: 'session-1',
      type: 'text',
      language: 'typescript',
      content: 'first\nsecond\nthird',
      startLine: 550,
      endLine: 600,
    }

    const wrapper = mount(FilePreview)
    await flushPromises()

    expect(wrapper.get('.preview-location').text()).toBe('L3')
    expect(wrapper.get('.preview-source-line[data-line="3"]').classes()).toContain('is-target-line')
    expect(wrapper.findAll('.preview-source-line.is-target-line')).toHaveLength(1)
    wrapper.unmount()
  })

  it('uses source-line mode for line-linked HTML instead of opening the rendered preview', async () => {
    previewMocks.fetchSessionWorkspaceFileBlob.mockResolvedValue({
      type: 'text/html; charset=utf-8',
      text: vi.fn().mockResolvedValue('<main>\n  <p>first</p>\n  <p>target</p>\n</main>'),
    } as unknown as Blob)
    const filesStore = useFilesStore()
    filesStore.previewFile = {
      path: 'report.html',
      name: 'report.html',
      size: 50,
      profile: null,
      workspaceSessionId: 'session-1',
      type: 'html',
      startLine: 3,
      endLine: 3,
    }

    const wrapper = mount(FilePreview, {
      global: {
        stubs: {
          HtmlFilePreview: { template: '<iframe />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('.preview-source-line[data-line="3"]').text()).toContain('<p>target</p>')
    expect(wrapper.get('.preview-source-line[data-line="3"]').classes()).toContain('is-target-line')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(previewMocks.openHtmlInDesktopBrowser).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
