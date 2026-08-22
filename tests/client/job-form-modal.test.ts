// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const mockMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
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

const mockListJobDeliveryTargets = vi.hoisted(() => vi.fn())
const mockGetJob = vi.hoisted(() => vi.fn())

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
    getJob: mockGetJob,
    listJobDeliveryTargets: mockListJobDeliveryTargets,
  }
})

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: mockFetchSkills,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: 'en-US' },
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
    mockListJobDeliveryTargets.mockResolvedValue({ updated_at: null, targets: [] })
  })

  it('loads delivery targets and models when opened', async () => {
    mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    expect(mockListJobDeliveryTargets).toHaveBeenCalledOnce()
    expect(mockAppStore.loadModels).toHaveBeenCalledOnce()
  })

  it('shows discovered profile channels as explicit delivery targets', async () => {
    mockListJobDeliveryTargets.mockResolvedValue({
      updated_at: '2026-07-17T09:15:00+08:00',
      targets: [
        {
          platform: 'weixin',
          id: 'wx-user@im.wechat',
          name: '微信私聊',
          type: 'dm',
          thread_id: null,
          value: 'weixin:wx-user@im.wechat',
        },
        {
          platform: 'feishu',
          id: 'oc_example',
          name: '研发群',
          type: 'group',
          thread_id: null,
          value: 'feishu:oc_example',
        },
      ],
    })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()

    const labels = wrapper.get('[data-testid="job-delivery"]').text()
    expect(labels).toContain('WeChat · 微信私聊 (dm)')
    expect(labels).toContain('Feishu · 研发群 (group)')

    const options = wrapper.get('[data-testid="job-delivery"]').findAll('option')
    const optionByValue = Object.fromEntries(options.map(option => [option.attributes('value'), option]))
    expect(optionByValue['weixin:wx-user@im.wechat']).toBeTruthy()
    expect(optionByValue['feishu:oc_example']).toBeTruthy()
  })

  it('submits selected skills when creating a job', async () => {
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('daily')
    await inputs[1].setValue('summarize updates')
    await wrapper.get('[data-testid="job-skills"]').setValue(['planner', 'reviewer'])
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith({
      name: 'Daily research',
      schedule: '0 9 * * *',
      prompt: 'summarize updates',
      deliver: 'local',
      skills: ['planner', 'reviewer'],
      repeat: undefined,
      provider: undefined,
      model: undefined,
    })
  })

  it('requires a prompt before creating a job', async () => {
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('daily')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockMessage.warning).toHaveBeenCalledWith('jobs.promptRequired')
    expect(mockJobsStore.createJob).not.toHaveBeenCalled()
    expect(mockMessage.success).not.toHaveBeenCalled()
  })

  it('submits selected provider and model when creating a job', async () => {
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Daily research')
    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('daily')
    await inputs[1].setValue('summarize updates')
    await wrapper.get('[data-testid="job-provider"]').setValue('openai')
    await flushPromises()
    await wrapper.get('[data-testid="job-model"]').setValue('gpt-4.1-mini')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    }))
  })

  it('submits the selected explicit delivery target when creating a job', async () => {
    mockListJobDeliveryTargets.mockResolvedValue({
      updated_at: null,
      targets: [{
        platform: 'weixin',
        id: 'wx-user@im.wechat',
        name: '微信私聊',
        type: 'dm',
        thread_id: null,
        value: 'weixin:wx-user@im.wechat',
      }],
    })
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('WeChat hello')
    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('every-5-minutes')
    await inputs[1].setValue('say hello')
    await wrapper.get('[data-testid="job-delivery"]').setValue('weixin:wx-user@im.wechat')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({
      deliver: 'weixin:wx-user@im.wechat',
    }))
  })

  it('only asks for an expression when the advanced custom schedule is selected', async () => {
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="job-schedule-custom"]').exists()).toBe(false)

    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('custom')

    expect(wrapper.find('[data-testid="job-schedule-custom"]').exists()).toBe(true)
  })

  it('builds a weekly schedule from weekday and time controls', async () => {
    mockJobsStore.createJob.mockResolvedValue({ id: 'job-1' })
    const wrapper = mount(JobFormModal, {
      props: { jobId: null },
    })

    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('Weekly report')
    await wrapper.get('[data-testid="job-schedule-frequency"]').setValue('weekly')
    await wrapper.get('[data-testid="job-schedule-weekday"]').setValue('3')
    await wrapper.get('[data-testid="job-schedule-hour"]').setValue('8')
    await wrapper.get('[data-testid="job-schedule-minute"]').setValue('30')
    await inputs[1].setValue('prepare the report')
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockJobsStore.createJob).toHaveBeenCalledWith(expect.objectContaining({
      schedule: '30 8 * * 3',
    }))
  })

  it('keeps an existing non-Cron schedule editable through the advanced option', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-custom',
      job_id: 'job-custom',
      name: 'Legacy interval',
      prompt: 'run it',
      schedule: { kind: 'interval', minutes: 90, display: 'every 90m' },
      schedule_display: 'every 90m',
      deliver: 'local',
      skills: [],
      repeat: { times: null, completed: 0 },
      provider: null,
      model: null,
    })
    const wrapper = mount(JobFormModal, {
      props: { jobId: 'job-custom' },
    })

    await flushPromises()

    expect(wrapper.get('[data-testid="job-schedule-custom"]').attributes('value')).toBe('every 90m')
  })
})
