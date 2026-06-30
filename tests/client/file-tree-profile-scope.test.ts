// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FileTree from '@/components/hermes/files/FileTree.vue'

const mockFilesApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
}))

vi.mock('@/api/hermes/files', () => mockFilesApi)

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NTree: { template: '<div class="n-tree-stub" />' },
}))

describe('FileTree profile scope', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockFilesApi.listFiles.mockResolvedValue({
      entries: [{ name: 'settings', path: 'settings', isDir: true, size: 0, modTime: '2026-06-30T00:00:00.000Z' }],
      path: '',
    })
  })

  it('loads root directories from the selected profile', async () => {
    mount(FileTree, { props: { profile: 'reviewer' } })
    await flushPromises()

    expect(mockFilesApi.listFiles).toHaveBeenCalledWith('', 'reviewer')
  })
})
