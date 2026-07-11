// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive, ref } from 'vue'

const role = { id: 'health-manager', name: 'Health Manager', description: 'Health lead', persona: 'Careful', builtIn: true, enabled: true, dataScope: { domains: ['health'], sections: ['observations'], includeProvenance: true }, capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' }, decisionAuthority: {}, spendingLimits: {}, memoryNamespace: 'health', escalationRules: [], createdAt: '', updatedAt: '', profileMappings: [], primaryProfileName: 'missing', mappingStale: true, recipeCount: 1 }
const custom = { ...role, id: 'custom-coach', name: 'Custom Coach', builtIn: false, primaryProfileName: 'default', mappingStale: false }
const store = reactive({
  roles: [role, custom] as any[], selectedRoleId: 'health-manager' as string | null, loading: false, saving: false, preview: null as any, error: null as string | null,
  fetchRoles: vi.fn(), createRole: vi.fn(), updateRole: vi.fn(), deleteRole: vi.fn(), cloneRole: vi.fn(), updateProfileMapping: vi.fn(), previewContext: vi.fn(),
  createRecipe: vi.fn(), updateRecipe: vi.fn(), deleteRecipe: vi.fn(),
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
  NInput: defineComponent({ props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button @click="$emit(\'update:value\', !value)">{{ value }}</button>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useDialog: () => ({ warning: ({ onPositiveClick }: any) => onPositiveClick() }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/components/hermes/profiles/AssistantRoleEditor.vue', () => ({ default: defineComponent({ props: ['show'], emits: ['save', 'close'], template: '<div v-if="show" data-test="editor-stub"><button data-test="editor-save" @click="$emit(\'save\', { role: { name: \'Saved\' }, profileName: \'default\', recipes: [{ id: \'daily\', name: \'Daily updated\', domains: [\'health\'], sections: [\'observations\'], limits: { perSection: 5, totalCharacters: 2000 } }] })">save</button><button data-test="editor-reconcile" @click="$emit(\'save\', { role: { name: \'Saved\' }, profileName: null, recipes: [{ name: \'New recipe\', domains: [\'health\'], sections: [\'observations\'], limits: { perSection: 5, totalCharacters: 2000 } }] })">reconcile</button></div>' }) }))
vi.mock('@/components/hermes/profiles/AssistantRolePreviewDrawer.vue', () => ({ default: defineComponent({ props: ['show', 'bundle'], template: '<div v-if="show" data-test="preview-stub">{{ bundle?.renderedInstructions }}</div>' }) }))

import AssistantRolesPanel from '@/components/hermes/profiles/AssistantRolesPanel.vue'

describe('AssistantRolesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks(); store.roles = [role, custom] as any; store.selectedRoleId = 'health-manager'; store.error = null; store.loading = false
    store.fetchRoles.mockResolvedValue(store.roles)
    fetchAssistantRole.mockImplementation(async (id: string) => ({ ...(id === custom.id ? custom : role), recipes: [{ id: id === custom.id ? 'custom-daily' : 'daily', roleId: id, name: 'Daily', description: '', builtIn: id !== custom.id, enabled: true, domains: ['health'], sections: ['observations'], queryTemplate: '', limits: { perSection: 10, totalCharacters: 4000 }, createdAt: '', updatedAt: '' }] }))
    store.createRole.mockResolvedValue(custom)
    store.updateRole.mockImplementation(async (id: string) => ({ ...(id === custom.id ? custom : role), recipes: [] }))
    store.cloneRole.mockResolvedValue(custom)
    store.deleteRole.mockResolvedValue(undefined)
    store.previewContext.mockResolvedValue({ renderedInstructions: 'server bundle', sections: {}, provenance: {}, truncated: { total: false, sections: {} } })
    store.updateRecipe.mockResolvedValue({ ...role, recipes: [] })
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
    expect(store.updateRecipe).toHaveBeenCalledWith('health-manager', 'daily', expect.objectContaining({ name: 'Daily updated' }))
    expect(store.deleteRole).toHaveBeenCalledWith('custom-coach')
    expect(store.previewContext).toHaveBeenCalledWith('health-manager', { recipeId: 'daily' })
    expect(wrapper.find('[data-test="preview-stub"]').text()).toContain('server bundle')

    store.error = 'offline'
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="roles-retry"]').trigger('click')
    expect(store.fetchRoles).toHaveBeenCalledTimes(2)
  })

  it('creates and deletes custom recipes to reconcile the persisted role detail', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    await wrapper.find('[data-test="edit-custom-coach"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="editor-reconcile"]').trigger('click')
    await flushPromises()
    expect(store.deleteRecipe).toHaveBeenCalledWith('custom-coach', 'custom-daily')
    expect(store.createRecipe).toHaveBeenCalledWith('custom-coach', expect.objectContaining({ name: 'New recipe' }))
  })

  it('never stages deletion of a built-in recipe', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    await wrapper.find('[data-test="edit-health-manager"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="editor-reconcile"]').trigger('click')
    await flushPromises()
    expect(store.deleteRecipe).not.toHaveBeenCalledWith('health-manager', 'daily')
  })

  it('retries a partially failed create as an update without creating a second role', async () => {
    store.createRecipe.mockRejectedValueOnce(new Error('recipe failed')).mockResolvedValueOnce(undefined)
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    await wrapper.find('[data-test="create-role"]').trigger('click')
    await wrapper.find('[data-test="editor-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="editor-stub"]').exists()).toBe(true)
    await wrapper.find('[data-test="editor-save"]').trigger('click')
    await flushPromises()
    expect(store.createRole).toHaveBeenCalledTimes(1)
    expect(store.updateRole).toHaveBeenCalledWith('custom-coach', expect.any(Object))
    expect(store.createRecipe).toHaveBeenCalledTimes(2)
  })

  it('keeps the editor open and reloads authoritative detail after a partial recipe failure', async () => {
    store.updateRecipe.mockRejectedValueOnce(new Error('recipe failed'))
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    await wrapper.find('[data-test="edit-health-manager"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="editor-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="editor-stub"]').exists()).toBe(true)
    expect(fetchAssistantRole.mock.calls.filter(([id]) => id === 'health-manager').length).toBeGreaterThanOrEqual(3)
  })

  it('does not open or save a stale role when the newly selected detail fails', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    fetchAssistantRole.mockRejectedValueOnce(new Error('B unavailable'))
    await wrapper.find('[data-test="edit-custom-coach"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="editor-stub"]').exists()).toBe(false)
    expect(store.updateRole).not.toHaveBeenCalled()
  })

  it('exposes keyboard-focusable listbox options and named controls', async () => {
    const wrapper = mount(AssistantRolesPanel)
    await flushPromises()
    expect(wrapper.find('ul[aria-label="Assistant roles"]').exists()).toBe(true)
    const select = wrapper.find('[data-test="select-role-health-manager"]')
    expect(select.element.tagName).toBe('BUTTON')
    expect(select.attributes('aria-current')).toBe('true')
    expect(wrapper.find('[data-test="toggle-health-manager"]').attributes('aria-label')).toContain('Health Manager')
    await select.trigger('keydown', { key: 'Enter' })
    expect(store.selectedRoleId).toBe('health-manager')
    await wrapper.find('[data-test="clone-custom-coach"]').trigger('click')
    expect(store.selectedRoleId).toBe('health-manager')
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
