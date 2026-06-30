// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  query: {
    profile: 'reviewer',
    file: 'config.yaml',
  } as Record<string, unknown>,
}))

const mockFilesStore = vi.hoisted(() => ({
  currentPath: '',
  editingFile: null as null | Record<string, unknown>,
  previewFile: null as null | Record<string, unknown>,
  fetchEntries: vi.fn(async () => {}),
  openEditor: vi.fn(async () => {}),
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: null as string | null,
  profiles: [] as Array<{ name: string }>,
  fetchProfiles: vi.fn(async () => {}),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => routeState,
  }
})

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => mockFilesStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/components/hermes/files/FileTree.vue', () => ({ default: { name: 'FileTreeStub', props: ['profile'], template: '<div class="FileTree-stub" />' } }))
vi.mock('@/components/hermes/files/FileBreadcrumb.vue', () => ({ default: { name: 'FileBreadcrumbStub', template: '<div class="FileBreadcrumb-stub" />' } }))
vi.mock('@/components/hermes/files/FileToolbar.vue', () => ({ default: { name: 'FileToolbarStub', template: '<div class="FileToolbar-stub" />' } }))
vi.mock('@/components/hermes/files/FileList.vue', () => ({ default: { name: 'FileListStub', template: '<div class="FileList-stub" />' } }))
vi.mock('@/components/hermes/files/FileContextMenu.vue', () => ({ default: { name: 'FileContextMenuStub', template: '<div class="FileContextMenu-stub" />' } }))
vi.mock('@/components/hermes/files/FileEditor.vue', () => ({ default: { name: 'FileEditorStub', template: '<div class="FileEditor-stub" />' } }))
vi.mock('@/components/hermes/files/FilePreview.vue', () => ({ default: { name: 'FilePreviewStub', template: '<div class="FilePreview-stub" />' } }))
vi.mock('@/components/hermes/files/FileUploadModal.vue', () => ({ default: { name: 'FileUploadModalStub', template: '<div class="FileUploadModal-stub" />' } }))
vi.mock('@/components/hermes/files/FileRenameModal.vue', () => ({ default: { name: 'FileRenameModalStub', template: '<div class="FileRenameModal-stub" />' } }))

import FilesView from '@/views/hermes/FilesView.vue'

describe('FilesView scoped config route handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query = { profile: 'reviewer', file: 'config.yaml' }
    mockProfilesStore.activeProfileName = null
    mockProfilesStore.profiles = []
    mockFilesStore.currentPath = ''
    mockFilesStore.editingFile = null
    mockFilesStore.previewFile = null
  })

  it('loads the requested profile root and opens config.yaml in the editor', async () => {
    shallowMount(FilesView)
    await flushPromises()

    expect(mockProfilesStore.fetchProfiles).toHaveBeenCalledOnce()
    expect(mockFilesStore.fetchEntries).toHaveBeenCalledWith('', { profile: 'reviewer' })
    expect(mockFilesStore.openEditor).toHaveBeenCalledWith('config.yaml', { profile: 'reviewer' })
  })
})
