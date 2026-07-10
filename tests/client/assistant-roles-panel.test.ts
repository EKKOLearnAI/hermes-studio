// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive, ref } from 'vue'

const role = { id: 'health-manager', name: 'Health Manager', description: 'Health lead', persona: 'Careful', builtIn: true, enabled: true, dataScope: { domains: ['health'], sections: ['observations'], includeProvenance: true }, capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' }, decisionAuthority: {}, spendingLimits: {}, memoryNamespace: 'health', escalationRules: [], createdAt: '', updatedAt: '', profileMappings: [], primaryProfileName: 'missing', mappingStale: true, recipeCount: 1 }
const custom = { ...role, id: 'custom-coach', name: 'Custom Coach', builtIn: false, primaryProfileName: 'default', mappingStale: false }
const store = reactive({
  roles: [role, custom] as any[], selectedRoleId: 'health-manager' as string | null, loading: false, saving: false, preview: null as any, error: null as string | null,
  fetchRoles: vi.fn(), createRole: vi.fn(), updateRole: vi.fn(), deleteRole: vi.fn(), cloneRole: vi.fn(), updateProfileMapping: vi.fn(), previewContext: vi.fn(),
})
const profilesStore = reactive({ profiles: [{ name: 'default' }], fetchHermesProfiles: vi.fn() })
const fetchAssistantRole = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes/assistant-roles', () => ({ useAssistantRolesStore: () => store }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStore }))
vi.mock('@/api/hermes/assistant-roles', async importOriginal => ({ ...(await importOriginal<any>()), fetchAssistantRole }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ template: '<div><slot /></div>' }),
  NButton: defineComponent({ props: ['disabled', 'loading'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' }),
  NEmpty: defineComponent({ template: '<div><slot /></div>' }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button @click="$emit(\'update:value\', !value)">{{ value }}</button>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useDialog: () => ({ warning: ({ onPositiveClick }: any) => onPositiveClick() }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/components/hermes/profiles/AssistantRoleEditor.vue', () => ({ default: defineComponent({ props: ['show'], emits: ['save', 'close'], template: '<div v-if="show" data-test="editor-stub"><button data-test="editor-save" @click="$emit(\'save\', { role: { name: \'Saved\' }, profileName: \'default\', recipes: [] })">save</button></div>' }) }))
vi.mock('@/components/hermes/profiles/AssistantRolePreviewDrawer.vue', () => ({ default: defineComponent({ props: ['show', 'bundle'], template: '<div v-if="show" data-test="preview-stub">{{ bundle?.renderedInstructions }}</div>' }) }))

import AssistantRolesPanel from '@/components/hermes/profiles/AssistantRolesPanel.vue'

describe('AssistantRolesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks(); store.roles = [role, custom] as any; store.selectedRoleId = 'health-manager'; store.error = null; store.loading = false
    store.fetchRoles.mockResolvedValue(store.roles)
    fetchAssistantRole.mockImplementation(async (id: string) => ({ ...(id === custom.id ? custom : role), recipes: [] }))
    store.updateRole.mockResolvedValue({ ...role, recipes: [] })
    store.cloneRole.mockResolvedValue(custom)
    store.deleteRole.mockResolvedValue(undefined)
    store.previewContext.mockResolvedValue({ renderedInstructions: 'server bundle', sections: {}, provenance: {}, truncated: { total: false, sections: {} } })
  })

  it('renders built-in/stale states and guards built-in deletion', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Built-in')
    expect(wrapper.text()).toContain('The mapped Runtime Profile is missing')
    expect(wrapper.find('[data-test="delete-health-manager"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="delete-custom-coach"]').attributes('disabled')).toBeUndefined()
  })

  it('supports clone, enable, edit/save, delete, preview, and retry', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    await wrapper.find('[data-test="clone-health-manager"]').trigger('click')
    await wrapper.find('[data-test="toggle-health-manager"]').trigger('click')
    await wrapper.find('[data-test="edit-health-manager"]').trigger('click')
    await wrapper.find('[data-test="editor-save"]').trigger('click')
    await wrapper.find('[data-test="delete-custom-coach"]').trigger('click')
    await wrapper.find('[data-test="preview-health-manager"]').trigger('click')
    await flushPromises()
    expect(store.cloneRole).toHaveBeenCalled()
    expect(store.updateRole).toHaveBeenCalled()
    expect(store.updateProfileMapping).toHaveBeenCalledWith('health-manager', 'default')
    expect(store.deleteRole).toHaveBeenCalledWith('custom-coach')
    expect(wrapper.find('[data-test="preview-stub"]').text()).toContain('server bundle')

    store.error = 'offline'
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="roles-retry"]').trigger('click')
    expect(store.fetchRoles).toHaveBeenCalledTimes(2)
  })

  it('shows loading and empty states', async () => {
    store.loading = true; store.roles = []
    const wrapper = mount(AssistantRolesPanel)
    expect(wrapper.find('[data-test="roles-loading"]').exists()).toBe(true)
    store.loading = false
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="roles-empty"]').exists()).toBe(true)
  })
})
