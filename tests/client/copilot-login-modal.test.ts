// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mockModelsStore = vi.hoisted(() => ({
  providers: [] as Array<{ provider: string }>,
  allProviders: [] as Array<{ provider: string }>,
  fetchProviders: vi.fn(),
}))

const mockAppStore = vi.hoisted(() => ({
  loadModels: vi.fn(),
}))

const mockMessage = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/stores/hermes/models', () => ({ useModelsStore: () => mockModelsStore }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => mockAppStore }))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))
vi.mock('naive-ui', () => ({
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NButton: { template: '<button @click="$emit(\'click\')"><slot /></button>' },
  useMessage: () => mockMessage,
}))

import CopilotLoginModal from '@/components/hermes/models/CopilotLoginModal.vue'

function mountModal() {
  return mount(CopilotLoginModal)
}

describe('CopilotLoginModal refreshDetect', () => {
  beforeEach(() => {
    mockModelsStore.providers = []
    mockModelsStore.allProviders = []
    mockModelsStore.fetchProviders.mockReset()
    mockAppStore.loadModels.mockReset()
    mockMessage.success.mockReset()
    mockMessage.warning.mockReset()
    mockMessage.error.mockReset()
  })

  it('当已授权 providers 不含 copilot 时，警告"未检测到"且不 emit success', async () => {
    mockModelsStore.providers = []
    // 关键回归测试：allProviders 含 copilot 也不应误判为成功
    mockModelsStore.allProviders = [{ provider: 'copilot' }]
    mockModelsStore.fetchProviders.mockResolvedValue(undefined)
    mockAppStore.loadModels.mockResolvedValue(undefined)

    const wrapper = mountModal()
    // 找到"重新检测"按钮（最后一个 button）并点击
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    await flushPromises()

    expect(mockMessage.warning).toHaveBeenCalledWith('models.copilotNotDetected')
    expect(mockMessage.success).not.toHaveBeenCalled()
    expect(wrapper.emitted('success')).toBeFalsy()
  })

  it('当已授权 providers 含 copilot 时，提示成功并 emit success', async () => {
    mockModelsStore.providers = [{ provider: 'copilot' }]
    mockModelsStore.fetchProviders.mockResolvedValue(undefined)
    mockAppStore.loadModels.mockResolvedValue(undefined)

    const wrapper = mountModal()
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    await flushPromises()

    expect(mockMessage.success).toHaveBeenCalledWith('models.copilotDetected')
    expect(wrapper.emitted('success')).toBeTruthy()
  })

  it('fetchProviders 抛错时显示 error', async () => {
    mockModelsStore.fetchProviders.mockRejectedValue(new Error('boom'))
    mockAppStore.loadModels.mockResolvedValue(undefined)

    const wrapper = mountModal()
    const buttons = wrapper.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    await flushPromises()

    expect(mockMessage.error).toHaveBeenCalled()
    expect(wrapper.emitted('success')).toBeFalsy()
  })
})
