// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const previewMocks = vi.hoisted(() => ({
  fetchFilePreviewBlob: vi.fn(),
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

vi.mock('@/api/hermes/files', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/hermes/files')>()
  return { ...actual, fetchFilePreviewBlob: previewMocks.fetchFilePreviewBlob }
})

vi.mock('@/utils/desktop-browser', () => ({
  openHtmlInDesktopBrowser: previewMocks.openHtmlInDesktopBrowser,
}))

import { useFilesStore } from '@/stores/hermes/files'
import FilePreview from '@/components/hermes/files/FilePreview.vue'

describe('desktop HTML file preview', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    previewMocks.fetchFilePreviewBlob.mockReset()
    previewMocks.openHtmlInDesktopBrowser.mockReset()
    previewMocks.fetchFilePreviewBlob.mockResolvedValue({
      type: 'text/html; charset=utf-8',
      text: vi.fn().mockResolvedValue('<!doctype html><html><body>Hello desktop</body></html>'),
    })
  })

  it('hands authenticated HTML content to the desktop browser instead of rendering an iframe', async () => {
    const filesStore = useFilesStore()
    const revealBrowser = () => filesStore.closePreview()
    window.addEventListener('hermes:open-desktop-browser-panel', revealBrowser)
    previewMocks.openHtmlInDesktopBrowser.mockImplementation(async () => {
      window.dispatchEvent(new CustomEvent('hermes:open-desktop-browser-panel'))
      return true
    })
    filesStore.previewFile = {
      path: 'reports/result.html',
      name: 'result.html',
      size: 54,
      profile: 'default',
      type: 'html',
    }

    const wrapper = mount(FilePreview, {
      global: {
        stubs: {
          HtmlFilePreview: { template: '<iframe />' },
        },
      },
    })
    await flushPromises()

    expect(previewMocks.fetchFilePreviewBlob).toHaveBeenCalledWith(
      'reports/result.html',
      'default',
      expect.any(AbortSignal),
    )
    expect(previewMocks.openHtmlInDesktopBrowser).toHaveBeenCalledWith(
      '<!doctype html><html><body>Hello desktop</body></html>',
      'result.html',
    )
    expect(wrapper.find('iframe').exists()).toBe(false)
    window.removeEventListener('hermes:open-desktop-browser-panel', revealBrowser)
  })

  it('keeps the iframe preview in the Web UI', async () => {
    previewMocks.openHtmlInDesktopBrowser.mockResolvedValue(false)
    const filesStore = useFilesStore()
    filesStore.previewFile = {
      path: 'reports/result.html',
      name: 'result.html',
      size: 54,
      profile: 'default',
      type: 'html',
    }

    const wrapper = mount(FilePreview, {
      global: {
        stubs: {
          HtmlFilePreview: {
            props: ['content'],
            template: '<iframe :data-content="content" />',
          },
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('iframe').attributes('data-content')).toContain('Hello desktop')
  })
})
