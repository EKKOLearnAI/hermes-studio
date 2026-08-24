// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { defineComponent } from 'vue'
import type { FileEntry } from '@/api/hermes/files'

const fetchSessionAttachment = vi.hoisted(() => vi.fn())
const fetchGroupAttachment = vi.hoisted(() => vi.fn())
const message = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/api/hermes/sessions', () => ({
  fetchSessionWorkspaceAttachmentBlob: fetchSessionAttachment,
}))
vi.mock('@/api/hermes/group-chat', () => ({
  fetchGroupWorkspaceAttachmentBlob: fetchGroupAttachment,
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({ template: '<button><slot /><slot name="icon" /></button>' }),
  useMessage: () => message,
}))
vi.mock('@/components/hermes/files/FileTree.vue', () => ({
  default: defineComponent({
    name: 'FileTreeStub',
    emits: ['open-entry', 'contextmenu-entry'],
    template: '<div />',
  }),
}))
vi.mock('@/components/hermes/files/FileBreadcrumb.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileToolbar.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileList.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileUploadModal.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileRenameModal.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileEditor.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/files/FileContextMenu.vue', () => ({
  default: defineComponent({
    name: 'FileContextMenuStub',
    emits: ['attach', 'rename', 'new-folder'],
    template: '<div />',
  }),
}))

import FilesPanel from '@/components/hermes/chat/FilesPanel.vue'

const entry: FileEntry = {
  name: 'report.pdf',
  path: 'reports/report.pdf',
  isDir: false,
  size: 5,
  modTime: '2026-06-02T00:00:00.000Z',
}

describe('FilesPanel workspace attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      media: '(max-width: 768px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
  })

  it('loads a session workspace file and emits it as a browser File', async () => {
    fetchSessionAttachment.mockResolvedValue(new Blob(['hello'], { type: 'application/pdf' }))
    const wrapper = mount(FilesPanel, {
      props: { workspaceSessionId: 'session-1', workspace: '/tmp/workspace' },
      global: { plugins: [createTestingPinia({ createSpy: vi.fn })] },
    })

    wrapper.getComponent({ name: 'FileContextMenuStub' }).vm.$emit('attach', entry)
    await flushPromises()

    expect(fetchSessionAttachment).toHaveBeenCalledWith('session-1', 'reports/report.pdf')
    const file = wrapper.emitted<File[]>('attach')?.[0]?.[0]
    expect(file).toBeInstanceOf(File)
    expect(file).toMatchObject({ name: 'report.pdf', type: 'application/pdf', size: 5 })
  })

  it('loads a group workspace file from the room endpoint', async () => {
    fetchGroupAttachment.mockResolvedValue(new Blob(['hello'], { type: 'text/plain' }))
    const wrapper = mount(FilesPanel, {
      props: { workspaceRoomId: 'room-1', workspace: '/tmp/room' },
      global: { plugins: [createTestingPinia({ createSpy: vi.fn })] },
    })

    wrapper.getComponent({ name: 'FileContextMenuStub' }).vm.$emit('attach', entry)
    await flushPromises()

    expect(fetchGroupAttachment).toHaveBeenCalledWith('room-1', 'reports/report.pdf')
    expect(wrapper.emitted('attach')).toHaveLength(1)
  })

  it('replaces the mobile tree with a selected file and returns to the same tree', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: '(max-width: 768px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    const wrapper = mount(FilesPanel, {
      props: { workspaceSessionId: 'session-1', workspace: '/tmp/workspace' },
      global: { plugins: [createTestingPinia({ createSpy: vi.fn })] },
    })

    wrapper.getComponent({ name: 'FileTreeStub' }).vm.$emit('open-entry', entry)
    await flushPromises()
    expect(wrapper.classes()).toContain('mobile-file-open')

    await wrapper.get('.sidebar-toggle').trigger('click')
    expect(wrapper.classes()).not.toContain('mobile-file-open')
    expect(wrapper.findComponent({ name: 'FileTreeStub' }).exists()).toBe(true)
  })
})
