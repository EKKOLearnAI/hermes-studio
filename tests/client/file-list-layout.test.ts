// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileList from '@/components/hermes/files/FileList.vue'
import { useFilesStore } from '@/stores/hermes/files'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /></button>' },
  NSpin: { props: ['show'], template: '<div><slot /></div>' },
  NEmpty: { props: ['description'], template: '<div class="empty">{{ description }}</div>' },
  useMessage: () => ({ error: vi.fn() }),
}))

describe('FileList layout', () => {
  beforeEach(() => {
    createTestingPinia({ stubActions: false, createSpy: vi.fn })
  })

  it('uses the same column grid for header and rows', () => {
    const store = useFilesStore()
    store.entries = [
      {
        name: 'very-long-file-name-that-should-not-push-size-or-date-columns.md',
        path: '/workspace/very-long-file-name-that-should-not-push-size-or-date-columns.md',
        isDir: false,
        size: 2048,
        modTime: '2026-06-06T08:00:00.000Z',
      },
    ]

    const wrapper = mount(FileList)

    expect(wrapper.find('.file-list-header').classes()).toContain('file-list-grid')
    expect(wrapper.find('.file-list-row').classes()).toContain('file-list-grid')
    expect(wrapper.find('.file-name .file-label').exists()).toBe(true)
  })
})
