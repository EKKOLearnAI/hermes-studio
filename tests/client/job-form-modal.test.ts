// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

const mockSettingsStore = vi.hoisted(() => ({
  platforms: {} as Record<string, any>,
  fetchSettings: vi.fn(async () => {
    mockSettingsStore.platforms = {
      telegram: { token: 'telegram-token' },
      discord: { token: 'discord-token' },
      slack: { token: 'slack-token' },
      whatsapp: { enabled: true },
      matrix: { token: 'matrix-token' },
      weixin: { token: 'weixin-token' },
      wecom: { extra: { bot_id: 'wecom-bot' } },
      feishu: { extra: { app_id: 'feishu-app' } },
      dingtalk: { extra: { client_id: 'dingtalk-client' } },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
  }),
}))

const mockJobsStore = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))

const mockAppStore = vi.hoisted(() => ({
  modelGroups: [
    { provider: 'openai', label: 'OpenAI', models: ['gpt-4.1', 'gpt-4.1-mini'] },
    { provider: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-4'] },
  ],
  loadModels: vi.fn(async () => undefined),
  displayModelName: vi.fn((model: string) => model),
}))

const mockFetchSkills = vi.hoisted(() => vi.fn(async () => ({
  categories: [
    {
      name: 'local',
      description: '',
      skills: [
        { name: 'planner', description: 'Plan work' },
        { name: 'reviewer', description: 'Review work' },
        { name: 'disabled-skill', description: 'Disabled', enabled: false },
      ],
    },
  ],
  archived: [],
})))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/jobs', () => ({
  useJobsStore: () => mockJobsStore,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/api/hermes/jobs', async () => {
  const actual = await vi.importActual<any>('@/api/hermes/jobs')
  return {
    ...actual,
    getJob: vi.fn(),
  }
})

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: mockFetchSkills,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    template: '<div class="n-modal-stub"><slot /><slot name="footer" /></div>',
  }),
  NForm: defineComponent({ template: '<form><slot /></form>' }),
  NFormItem: defineComponent({ template: '<div><slot /></div>' }),
  NInput: defineComponent({
    props: { value: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NInputNumber: defineComponent({
    props: { value: { required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-number-stub" :value="value" type="number" @input="$emit(\'update:value\', Number($event.target.value))" />',
  }),
  NSelect: defineComponent({
    props: {
      value: { required: false },
      options: { type: Array, default: () => [] },
      multiple: { type: Boolean, default: false },
      disabled: { type: Boolean, default: false },
    },
    emits: ['update:value'],
    template: '<select class="n-select-stub" :multiple="multiple" :disabled="disabled" @change="$emit(\'update:value\', multiple ? Array.from($event.target.selectedOptions).map(option => option.value) : $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option></select>',
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  useMessage: () => mockMessage,
}))

import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'

describe('JobFormModal deliver targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingsStore.platforms = {}
  })

  it('loads platform settings when the store has not been hydrated', async () => {
    mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(mockSettingsStore.fetchSettings).toHaveBeenCalledOnce()
    expect(mockAppStore.loadModels).toHaveBeenCalledOnce()
  })

  it('shows every supported platform channel in deliver target options', async () => {
    mockSettingsStore.platforms = {
      telegram: { token: 'telegram-token' },
      whatsapp: { enabled: false },
      qqbot: { extra: { app_id: 'qq-app', client_secret: 'qq-secret' } },
    }
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(mockSettingsStore.fetchSettings).not.toHaveBeenCalled()
    const labels = wrapper.findAll('.n-select-stub')[4].text()
    expect(labels).toContain('Telegram')
    expect(labels).toContain('Discord')
    expect(labels).toContain('Slack')
    expect(labels).toContain('WhatsApp')
    expect(labels).toContain('Matrix')
    expect(labels).toContain('WeChat')
    expect(labels).toContain('WeCom')
    expect(labels).toContain('Feishu')
    expect(labels).toContain('DingTalk')
    expect(labels).toContain('QQBot')

    const options = wrapper.findAll('.n-select-stub')[4].findAll('option')
    const optionByValue = Object.fromEntries(options.map(option => [option.attributes('value'), option]))
    expect(optionByValue.telegram.attributes('disabled')).toBeUndefined()
    expect(optionByValue.qqbot.attributes('disabled')).toBeUndefined()
    expect(optionByValue.discord.attributes('disabled')).toBe('')
    expect(optionByValue.whatsapp.attributes('disabled')).toBe('')
  })

  it('submits selected skills when creating a job', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('summarize updates')
    await wrapper.findAll('.n-select-stub')[3].setValue(['planner', 'reviewer'])
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: 'Daily research',
      schedule: '0 9 * * *',
      prompt: 'summarize updates',
      deliver: 'origin',
      skills: ['planner', 'reviewer'],
      repeat: undefined,
      provider: undefined,
      model: undefined,
    })
  })

  it('submits selected provider and model when creating a job', async () => {
    mockSettingsStore.platforms = { telegram: { token: 'telegram-token' } }
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await inputs[1].setValue('0 9 * * *')
    await inputs[2].setValue('summarize updates')
    await wrapper.findAll('.n-select-stub')[0].setValue('openai')
    await flushPromises()
    await wrapper.findAll('.n-select-stub')[1].setValue('gpt-4.1-mini')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    }))
  })
})
