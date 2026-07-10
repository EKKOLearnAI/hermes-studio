// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

const fetchHermesProfiles = vi.hoisted(() => vi.fn())
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ profiles: [], loading: false, fetchHermesProfiles }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({ emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NTabs: defineComponent({ template: '<div data-test="tabs"><slot /></div>' }),
  NTabPane: defineComponent({ props: ['name', 'tab'], template: '<section :data-tab="name"><h3>{{ tab }}</h3><slot /></section>' }),
}))
vi.mock('@/components/hermes/profiles/ProfilesPanel.vue', () => ({ default: defineComponent({ emits: ['rename'], template: '<div data-test="profiles-panel" />' }) }))
vi.mock('@/components/hermes/profiles/AssistantRolesPanel.vue', () => ({ default: defineComponent({ template: '<div data-test="assistant-roles-panel" />' }) }))
vi.mock('@/components/hermes/profiles/ProfileCreateModal.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/profiles/ProfileRenameModal.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/profiles/ProfileImportModal.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

import ProfilesView from '@/views/hermes/ProfilesView.vue'

describe('ProfilesView', () => {
  it('shows Runtime Profiles and Assistant Roles tabs while preserving runtime profile controls', () => {
    const wrapper = mount(ProfilesView)
    expect(wrapper.text()).toContain('Runtime Profiles')
    expect(wrapper.text()).toContain('Assistant Roles')
    expect(wrapper.find('[data-test="profiles-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="assistant-roles-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('profiles.import')
    expect(wrapper.text()).toContain('profiles.create')
    expect(fetchHermesProfiles).toHaveBeenCalled()
  })
})
