// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'

const requestMock = vi.hoisted(() => vi.fn())
const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))
const dialogMock = vi.hoisted(() => ({
  warning: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  request: requestMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default?.())
    },
  }),
  NDropdown: defineComponent({
    name: 'NDropdown',
    props: { show: Boolean, options: { type: Array, default: () => [] } },
    setup(props) {
      return () => h('div', { class: 'dropdown-stub' }, props.show ? JSON.stringify(props.options) : '')
    },
  }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: { type: String, default: '' }, placeholder: String },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.value,
        placeholder: props.placeholder,
        onInput: (event: Event) => emit('update:value', (event.target as HTMLInputElement).value),
      })
    },
  }),
  NModal: defineComponent({
    name: 'NModal',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
  NSpace: defineComponent({
    name: 'NSpace',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    setup() {
      return () => h('div', { class: 'spin-stub' })
    },
  }),
  useDialog: () => dialogMock,
  useMessage: () => messageMock,
}))

describe('FolderPicker Windows drives', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestMock.mockImplementation(async (url: string) => {
      if (url === '/api/hermes/workspace/folders') {
        return {
          base: '',
          current: '',
          folders: [
            { name: 'C:\\', path: 'C:\\', fullPath: 'C:\\', readonly: true },
            { name: 'D:\\', path: 'D:\\', fullPath: 'D:\\', readonly: true },
          ],
        }
      }
      if (url === '/api/hermes/workspace/folders?path=D%3A%5C') {
        return {
          base: 'D:\\',
          current: 'D:\\',
          folders: [
            { name: 'Projects', path: 'D:\\Projects', fullPath: 'D:\\Projects' },
          ],
        }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  it('renders and expands Windows drive roots', async () => {
    const wrapper = mount(FolderPicker, { props: { modelValue: null } })

    await flushPromises()

    expect(wrapper.text()).toContain('C:\\')
    expect(wrapper.text()).toContain('D:\\')

    const drive = wrapper.findAll('.folder-item').find(item => item.text().includes('D:\\'))
    expect(drive).toBeTruthy()

    await drive!.find('.folder-expand').trigger('click')
    await flushPromises()

    expect(requestMock).toHaveBeenCalledWith('/api/hermes/workspace/folders?path=D%3A%5C')
    expect(wrapper.text()).toContain('Projects')
  })
})
