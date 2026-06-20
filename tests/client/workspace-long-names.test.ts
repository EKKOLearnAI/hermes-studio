// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileTree from '@/components/hermes/files/FileTree.vue'
import { useFilesStore } from '@/stores/hermes/files'
import { listFiles } from '@/api/hermes/files'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn() }),
}))

vi.mock('@/api/hermes/files', () => ({
  listFiles: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  downloadFile: vi.fn(),
}))

const NSpinStub = defineComponent({
  props: ['show'],
  setup(_props, { slots }) {
    return () => h('div', slots.default?.())
  },
})

const NButtonStub = defineComponent({
  props: ['title'],
  setup(props, { slots }) {
    return () => h('button', { title: props.title }, slots.default?.())
  },
})

const NEmptyStub = defineComponent({
  props: ['description'],
  setup(props) {
    return () => h('div', String(props.description || ''))
  },
})

const NTreeStub = defineComponent({
  props: ['data', 'renderLabel'],
  setup(props) {
    return () => h('div', (props.data || []).map((option: any) =>
      h('div', { class: 'tree-node' }, [props.renderLabel({ option })]),
    ))
  },
})

function mountFileList() {
  return mount(FileList, {
    global: {
      stubs: {
        NSpin: NSpinStub,
        NButton: NButtonStub,
        NEmpty: NEmptyStub,
      },
    },
  })
}

describe('workspace long names', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('exposes full file names as hover titles in the file list', () => {
    const store = useFilesStore()
    const longName = 'very-long-generated-report-name-that-would-be-truncated-in-the-workspace-list.md'
    store.entries = [{
      name: longName,
      path: longName,
      isDir: false,
      size: 123,
      modTime: '2026-06-16T00:00:00Z',
    }]

    const wrapper = mountFileList()

    expect(wrapper.find('.file-label').text()).toBe(longName)
    expect(wrapper.find('.file-label').attributes('title')).toBe(longName)
  })

  it('exposes full folder names as hover titles in the workspace tree', async () => {
    const longName = 'very-long-folder-name-that-needs-a-hover-title'
    vi.mocked(listFiles).mockResolvedValue({
      path: '',
      entries: [{
        name: longName,
        path: longName,
        isDir: true,
        size: 0,
        modTime: '2026-06-16T00:00:00Z',
      }],
    } as any)

    const wrapper = mount(FileTree, {
      global: {
        stubs: {
          NTree: NTreeStub,
        },
      },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('.tree-node-label').exists()).toBe(true)
    })

    expect(wrapper.find('.tree-node-label').text()).toBe(longName)
    expect(wrapper.find('.tree-node-label').attributes('title')).toBe(longName)
  })
})
