// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { useModelsStore } from '@/stores/hermes/models'

const fetchFallbackProvidersMock = vi.hoisted(() => vi.fn())
const saveFallbackProvidersMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>' },
  NInput: { props: ['value', 'placeholder', 'size', 'clearable'], template: '<input />' },
  NModal: { template: '<div><slot /></div>' },
  NSpin: { template: '<div><slot /></div>' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/api/hermes/config', () => ({
  fetchFallbackProviders: fetchFallbackProvidersMock,
  saveFallbackProviders: saveFallbackProvidersMock,
}))

import FallbackProvidersPanel from '@/components/hermes/models/FallbackProvidersPanel.vue'

const CHAIN = [
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
  { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  { provider: 'lmstudio', model: 'kimi-k3' },
]

async function mountPanel() {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const modelsStore = useModelsStore()
  modelsStore.providers = [
    { provider: 'openrouter', label: 'OpenRouter', models: ['anthropic/claude-sonnet-4'] },
    { provider: 'openai-codex', label: 'OpenAI Codex', models: ['gpt-5.6-sol'] },
    { provider: 'lmstudio', label: 'LM Studio', models: ['kimi-k3'] },
    { provider: 'xai', label: 'xAI', models: ['grok-4'] },
  ] as any
  const wrapper = mount(FallbackProvidersPanel, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function dragRowOnto(wrapper: any, from: number, to: number) {
  const rows = wrapper.findAll('.fallback-row')
  rows[from].trigger('dragstart', { dataTransfer: { setData: vi.fn(), effectAllowed: '' } })
  rows[to].trigger('dragenter')
  rows[to].trigger('dragend')
}

/**
 * The order of this list is the order Hermes tries the models in, so what the
 * rows read after a drag has to be exactly what gets saved.
 */
describe('fallback providers panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchFallbackProvidersMock.mockResolvedValue({ fallback_providers: [...CHAIN] })
    saveFallbackProvidersMock.mockImplementation(async (chain: any[]) => ({
      success: true,
      fallback_providers: chain,
    }))
  })

  it('loads the saved chain in order', async () => {
    const wrapper = await mountPanel()
    const rows = wrapper.findAll('.fallback-row')

    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('anthropic/claude-sonnet-4')
    expect(rows[2].text()).toContain('kimi-k3')
  })

  it('adds a model through the shared model picker', async () => {
    const wrapper = await mountPanel()

    await wrapper.findAll('button').find((button: any) => button.text() === 'models.fallbackAdd')!.trigger('click')
    await wrapper.findAll('.model-item').find((item: any) => item.text().includes('grok-4'))!.trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.fallback-row')
    expect(rows).toHaveLength(4)
    expect(rows[3].text()).toContain('grok-4')
  })

  it('reorders by dragging a row onto another and saves the new order', async () => {
    const wrapper = await mountPanel()

    // Drag the last entry to the front.
    dragRowOnto(wrapper, 2, 0)
    await flushPromises()

    const rows = wrapper.findAll('.fallback-row')
    expect(rows[0].text()).toContain('kimi-k3')
    expect(rows[1].text()).toContain('anthropic/claude-sonnet-4')

    await wrapper.findAll('button').find((b: any) => b.text() === 'common.save')!.trigger('click')
    await flushPromises()

    expect(saveFallbackProvidersMock).toHaveBeenCalledWith([
      { provider: 'lmstudio', model: 'kimi-k3' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
      { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    ])
  })

  it('moves a focused row with Alt and an arrow key, for people not using a mouse', async () => {
    const wrapper = await mountPanel()

    await wrapper.findAll('.fallback-row')[0].trigger('keydown', { key: 'ArrowDown', altKey: true })
    await flushPromises()

    const rows = wrapper.findAll('.fallback-row')
    expect(rows[0].text()).toContain('gpt-5.6-sol')
    expect(rows[1].text()).toContain('anthropic/claude-sonnet-4')
  })

  it('ignores an arrow key pressed without Alt, so reading the list cannot reorder it', async () => {
    const wrapper = await mountPanel()

    await wrapper.findAll('.fallback-row')[0].trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()

    expect(wrapper.findAll('.fallback-row')[0].text()).toContain('anthropic/claude-sonnet-4')
  })

  it('keeps save disabled until something actually changes', async () => {
    const wrapper = await mountPanel()
    const save = wrapper.findAll('button').find((b: any) => b.text() === 'common.save')!

    expect(save.attributes('disabled')).toBeDefined()

    dragRowOnto(wrapper, 1, 0)
    await flushPromises()

    expect(wrapper.findAll('button').find((b: any) => b.text() === 'common.save')!.attributes('disabled')).toBeUndefined()
  })
})
