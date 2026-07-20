// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleApiMock = vi.hoisted(() => vi.fn())
const dialogWarningMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    props: ['value', 'min', 'max', 'step'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: dialogWarningMock }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: deleteSkillBundleApiMock,
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: {
    name: 'BundleCreateModal',
    props: ['profile'],
    emits: ['close', 'created'],
    template: '<div class="bundle-create-modal">{{ profile }}</div>',
  },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

function mountForSession(
  sessionId: string,
  sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {},
  displayOverrides: Record<string, any> = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = displayOverrides
  return mount(ChatInput, { global: { plugins: [pinia] } })
}

describe('ChatInput draft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
    deleteSkillBundleApiMock.mockReset()
    deleteSkillBundleApiMock.mockResolvedValue(undefined)
    dialogWarningMock.mockReset()
  })

  it('restores unsent text for the active session after the chat view is remounted', async () => {
    const wrapper = mountForSession('session-a')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('draft before tab switch')
    await nextTick()
    wrapper.unmount()

    const remounted = mountForSession('session-a')
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('draft before tab switch')
  })

  it('stores drafts under one localStorage key mapped by session id', async () => {
    const wrapperA = mountForSession('session-a')
    await wrapperA.get('textarea').setValue('draft for session a')
    await nextTick()
    wrapperA.unmount()

    const wrapperB = mountForSession('session-b')
    await wrapperB.get('textarea').setValue('draft for session b')
    await nextTick()
    wrapperB.unmount()

    expect(localStorage.getItem('hermes_chat_input_draft_v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}')).toEqual({
      'session-a': 'draft for session a',
      'session-b': 'draft for session b',
    })

    const remountedA = mountForSession('session-a')
    await nextTick()
    expect((remountedA.get('textarea').element as HTMLTextAreaElement).value).toBe('draft for session a')
  })

  it('shows and cancels the active session message reference', async () => {
    const wrapper = mountForSession('session-reference')
    const chatStore = useChatStore()

    chatStore.setMessageReference('session-reference', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'A referenced assistant response',
    })
    await nextTick()

    expect(wrapper.get('.message-reference-preview').text()).toContain('A referenced assistant response')
    expect(wrapper.get('.message-reference-preview').element.parentElement?.classList.contains('input-wrapper')).toBe(false)
    expect(chatStore.activeMessageReference?.id).toBe('assistant-1')

    await wrapper.get('.message-reference-remove').trigger('click')

    expect(wrapper.find('.message-reference-preview').exists()).toBe(false)
    expect(chatStore.activeMessageReference).toBeNull()
  })

  it('applies the configured desktop input height from display settings', async () => {
    const wrapper = mountForSession('session-a', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('180px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('251px')
  })

  it('applies display setting changes after a manual resize', async () => {
    const wrapper = mountForSession('session-a')
    const settingsStore = useSettingsStore()
    const resizeHandle = wrapper.get('.resize-handle')

    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    settingsStore.display.chat_input_height = 220
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('220px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('291px')
  })

  it('keeps mobile chat input behavior even when a desktop height is configured', async () => {
    window.innerWidth = 640
    const wrapper = mountForSession('session-mobile', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).not.toBe('180px')
  })

  it('shows context usage for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 1200,
      outputTokens: 800,
      contextTokens: 2000,
    })
    await nextTick()

    expect(wrapper.find('.context-info').exists()).toBe(true)
    expect(wrapper.find('.context-info').text()).toContain('2.0k')
    expect(wrapper.find('.context-bar').exists()).toBe(true)
  })

  it('shows reasoning effort selector for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    await nextTick()

    expect(wrapper.find('.n-popover-stub').exists()).toBe(true)
    expect(wrapper.find('.n-slider-stub').exists()).toBe(true)
    expect(wrapper.get('.n-slider-stub').attributes('min')).toBe('0')
    expect(wrapper.get('.n-slider-stub').attributes('max')).toBe('7')
  })

  it('hides the reasoning effort selector for MoA sessions', async () => {
    const wrapper = mountForSession('session-moa', {
      provider: 'moa',
      model: 'research-team',
    })
    await nextTick()

    expect(wrapper.find('.n-popover-stub').exists()).toBe(false)
  })

  it('stores maximum reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning-max')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('7')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('max')
    expect(localStorage.getItem('hermes:reasoning_effort:session-reasoning-max')).toBe('max')
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #ef4444')
    expect(wrapper.get('.n-slider-stub').classes()).toContain('reasoning-effort-slider--max')
  })

  it('stores the selected reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('5')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(localStorage.getItem('hermes:reasoning_effort:session-reasoning')).toBe('high')
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #f9c33c')
    expect(wrapper.get('.n-slider-stub').classes()).not.toContain('reasoning-effort-slider--max')
  })

  it('opens the skill picker from /skill and inserts the selected skill command', async () => {
    fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'review',
          description: '',
          skills: [
            { name: 'github-pr-review', description: 'Review pull requests', enabled: true },
            { name: 'disabled-skill', description: 'Hidden', enabled: false },
          ],
        },
      ],
      archived: [],
    })
    const wrapper = mountForSession('session-skills', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/skill')
    await nextTick()

    await wrapper.get('.slash-command-item').trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillsMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/skill github-pr-review')
    expect(wrapper.text()).toContain('Review pull requests')
    expect(wrapper.text()).not.toContain('disabled-skill')

    await wrapper.get('.skill-picker-item').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill github-pr-review ')
  })

  it('opens the profile-scoped bundle picker from /bundles and inserts the selected bundle command', async () => {
    fetchSkillBundlesMock.mockResolvedValue([
      {
        name: 'PR Review Team',
        commandName: 'pr-review-team',
        description: 'Review a pull request',
        skills: ['github-pr-review', 'security-review'],
      },
    ])
    const wrapper = mountForSession('session-bundles', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles')
    await nextTick()
    await wrapper.findAll('.slash-command-item')[0].trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillBundlesMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/bundles pr-review-team')
    expect(wrapper.text()).toContain('Review a pull request')
    expect(wrapper.text()).toContain('github-pr-review, security-review')

    await wrapper.get('.bundle-picker-select').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/bundles pr-review-team ')
  })

  it('opens the bundle creator when /bundles create is submitted', async () => {
    const wrapper = mountForSession('session-bundle-create', { profile: 'research' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles create')
    await nextTick()
    await wrapper.get('.send-button').trigger('click')
    await nextTick()

    expect(wrapper.get('.bundle-create-modal').text()).toBe('research')
  })

  it('deletes a bundle from the current profile after confirmation', async () => {
    fetchSkillBundlesMock.mockResolvedValue([
      {
        name: 'PR Review Team',
        commandName: 'pr-review-team',
        description: '',
        skills: ['github-pr-review'],
      },
    ])
    const wrapper = mountForSession('session-bundle-delete', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/bundles')
    await nextTick()
    await wrapper.findAll('.slash-command-item')[0].trigger('mousedown')
    await flushPromises()
    await wrapper.get('.bundle-picker-delete').trigger('click')

    expect(dialogWarningMock).toHaveBeenCalledOnce()
    await dialogWarningMock.mock.calls[0][0].onPositiveClick()
    await flushPromises()

    expect(deleteSkillBundleApiMock).toHaveBeenCalledWith('work', 'pr-review-team')
    expect(wrapper.text()).not.toContain('/bundles pr-review-team')
  })

  it('hides bridge autocomplete for non-Hermes slash prefixes', async () => {
    const wrapper = mountForSession('session-prefixes')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/')
    await nextTick()
    expect(wrapper.findAll('.slash-command-item').length).toBeGreaterThan(0)

    await textarea.setValue('/ter')
    await nextTick()

    expect(wrapper.find('.slash-command-dropdown').exists()).toBe(false)
  })
})
