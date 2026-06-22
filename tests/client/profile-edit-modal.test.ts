// @vitest-environment jsdom
import { defineComponent, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProfileEditModal from '../../packages/client/src/components/hermes/profiles/ProfileEditModal.vue'

const profileEditModalMocks = vi.hoisted(() => ({
  fetchProfileDetail: vi.fn(),
  updateProfileModel: vi.fn(),
  fetchAvailableModelsForProfile: vi.fn(),
  message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    fetchProfileDetail: profileEditModalMocks.fetchProfileDetail,
    updateProfileModel: profileEditModalMocks.updateProfileModel,
  }),
}))

vi.mock('@/api/hermes/system', () => ({
  fetchAvailableModelsForProfile: profileEditModalMocks.fetchAvailableModelsForProfile,
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
  NForm: defineComponent({
    template: '<form><slot /></form>',
  }),
  NFormItem: defineComponent({
    template: '<div><slot /></div>',
  }),
  NSelect: defineComponent({
    props: {
      value: { type: String, default: '' },
      options: { type: Array, default: () => [] },
      placeholder: { type: String, default: '' },
      clearable: { type: Boolean, default: false },
      filterable: { type: Boolean, default: false },
    },
    emits: ['update:value'],
    template: `
      <select class="n-select-stub" :value="value" @change="$emit('update:value', $event.target.value)">
        <option value=""></option>
        <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    `,
  }),
  NButton: defineComponent({
    emits: ['click'],
    template: '<button class="n-button-stub" @click.prevent="$emit(\'click\')"><slot /></button>',
  }),
  NSpin: defineComponent({
    props: { show: { type: Boolean, default: false } },
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
  NText: defineComponent({
    template: '<span><slot /></span>',
  }),
  useMessage: () => profileEditModalMocks.message,
}))

describe('ProfileEditModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    profileEditModalMocks.fetchProfileDetail.mockResolvedValue({
      name: 'research',
      path: '/tmp/research',
      model: 'gpt-5',
      provider: 'openai',
      skills: 1,
      hasEnv: false,
      hasSoulMd: false,
    })
    profileEditModalMocks.fetchAvailableModelsForProfile.mockResolvedValue({
      groups: [
        { provider: 'openai', label: 'OpenAI', base_url: '', api_key: '', models: ['gpt-5', 'gpt-5.5'] },
        { provider: 'anthropic', label: 'Anthropic', base_url: '', api_key: '', models: ['claude-sonnet-4-6'] },
      ],
    })
    profileEditModalMocks.updateProfileModel.mockResolvedValue(true)
  })

  it('shows selectable models and saves the selected provider/model pair', async () => {
    const wrapper = mount(ProfileEditModal, {
      props: {
        profile: {
          name: 'research',
          active: false,
          model: 'gpt-5',
          alias: '',
        },
      },
    })

    await flushPromises()
    await nextTick()

    const select = wrapper.find('.n-select-stub')
    expect(select.exists()).toBe(true)
    expect(wrapper.findAll('option').map(option => option.text())).toEqual(expect.arrayContaining([
      'OpenAI / gpt-5',
      'OpenAI / gpt-5.5',
      'Anthropic / claude-sonnet-4-6',
    ]))

    await select.setValue(JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6' }))
    await wrapper.findAll('.n-button-stub')[1].trigger('click')

    expect(profileEditModalMocks.updateProfileModel).toHaveBeenCalledWith('research', 'claude-sonnet-4-6', 'anthropic')
    expect(profileEditModalMocks.message.success).toHaveBeenCalledWith('common.saved')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })
})
