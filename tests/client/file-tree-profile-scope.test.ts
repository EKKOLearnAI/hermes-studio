// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FileTree from '@/components/hermes/files/FileTree.vue'
import { useFilesStore } from '@/stores/hermes/files'

const mockFilesApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
}))

vi.mock('@/api/hermes/files', () => mockFilesApi)

const mockSessionsApi = vi.hoisted(() => ({
  listSessionWorkspaceFiles: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => mockSessionsApi)

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

  it('reloads the workspace tree when the workspace path changes for the same session', async () => {
    mockSessionsApi.listSessionWorkspaceFiles
      .mockResolvedValueOnce({
        entries: [{ name: 'first-workspace', path: 'first-workspace', isDir: true, size: 0, modTime: '2026-07-09T00:00:00.000Z' }],
        path: '',
      })
      .mockResolvedValueOnce({
        entries: [{ name: 'second-workspace', path: 'second-workspace', isDir: true, size: 0, modTime: '2026-07-09T00:00:00.000Z' }],
        path: '',
      })

    const store = useFilesStore()
    store.currentWorkspaceSessionId = 'session-1'

    const wrapper = mount(FileTree, { props: { workspaceKey: '/tmp/first-workspace' } })
    await flushPromises()

    await wrapper.setProps({ workspaceKey: '/tmp/second-workspace' })
    await flushPromises()

    expect(mockSessionsApi.listSessionWorkspaceFiles).toHaveBeenCalledTimes(2)
    expect(mockSessionsApi.listSessionWorkspaceFiles).toHaveBeenNthCalledWith(1, 'session-1', '')
    expect(mockSessionsApi.listSessionWorkspaceFiles).toHaveBeenNthCalledWith(2, 'session-1', '')
    expect(mockFilesApi.listFiles).not.toHaveBeenCalled()
  })
})
