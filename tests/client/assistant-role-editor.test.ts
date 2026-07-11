// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ template: '<div class="alert"><slot /></div>' }),
  NButton: defineComponent({ props: ['disabled', 'loading'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' }),
  NInput: defineComponent({ props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' }),
  NModal: defineComponent({ props: ['show'], template: '<section v-if="show"><slot /><slot name="footer" /></section>' }),
  NDrawer: defineComponent({ props: ['show'], template: '<aside v-if="show"><slot /></aside>' }),
  NDrawerContent: defineComponent({ template: '<div><slot /></div>' }),
  NEmpty: defineComponent({ template: '<div><slot /></div>' }),
  NSwitch: defineComponent({ props: ['value'], emits: ['update:value'], template: '<button @click="$emit(\'update:value\', !value)">{{ value }}</button>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
}))

import AssistantRoleEditor from '@/components/hermes/profiles/AssistantRoleEditor.vue'
import AssistantRolePreviewDrawer from '@/components/hermes/profiles/AssistantRolePreviewDrawer.vue'

const role = {
  id: 'health-manager', name: 'Health Manager', description: 'Health lead', persona: 'Be careful.',
  builtIn: true, enabled: true,
  dataScope: { domains: ['health'], sections: ['observations'], includeProvenance: true },
  capabilityScope: { allow: ['health.read'], deny: [], enforcement: 'action_fabric_v1' },
  decisionAuthority: { maxRisk: 'none' }, spendingLimits: { currency: null, perAction: 0, daily: 0 }, memoryNamespace: 'health', escalationRules: [],
  createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
  profileMappings: [], primaryProfileName: null, mappingStale: false, recipeCount: 1,
  recipes: [{
    id: 'daily', roleId: 'health-manager', name: 'Daily', description: '', builtIn: true, enabled: true,
    domains: ['health'], sections: ['observations'], queryTemplate: '',
    limits: { perSection: 10, totalCharacters: 4000 }, createdAt: '', updatedAt: '',
  }],
} as any

describe('AssistantRoleEditor', () => {
  it('validates identity and exposes domain, section, capability, and mapping controls', async () => {
    const wrapper = mount(AssistantRoleEditor, { props: { show: true, mode: 'edit', role: { ...role, builtIn: false }, profileNames: ['default'] } })
    expect(wrapper.text()).toContain('Capability permissions are enforced by Action Fabric. External executors are not available yet.')
    expect(wrapper.find('[data-test="role-domain-health"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="role-section-observations"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="role-profile-mapping"]').exists()).toBe(true)

    await wrapper.find('[data-test="role-name"]').setValue('')
    await wrapper.find('[data-test="role-save"]').trigger('click')
    expect(wrapper.find('[data-test="role-validation-error"]').text()).toContain('Name is required')
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('clamps recipe limits and emits a valid role update', async () => {
    const wrapper = mount(AssistantRoleEditor, { props: { show: true, mode: 'edit', role, profileNames: ['default'] } })
    await wrapper.find('[data-test="recipe-per-section"]').setValue('0')
    await wrapper.find('[data-test="recipe-total-characters"]').setValue('999999')
    await wrapper.find('[data-test="role-domain-fitness"]').setValue(true)
    await wrapper.find('[data-test="role-save"]').trigger('click')

    const payload = wrapper.emitted('save')?.[0]?.[0] as any
    expect(payload.role.dataScope.domains).toContain('fitness')
    expect(payload.recipes[0].limits).toEqual({ perSection: 1, totalCharacters: 40000 })
  })

  it('edits all recipe fields and supports adding and deleting recipe drafts', async () => {
    const wrapper = mount(AssistantRoleEditor, { props: { show: true, mode: 'edit', role, profileNames: ['default'] } })
    const builtInDelete = wrapper.find('[data-test="delete-recipe"]')
    expect(builtInDelete.attributes('disabled')).toBeDefined()
    expect(builtInDelete.attributes('aria-label')).toContain('Built-in')
    await builtInDelete.trigger('click')
    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(1)
    await wrapper.find('[data-test="recipe-name"]').setValue('Morning health')
    await wrapper.find('[data-test="recipe-query-template"]').setValue('last 24 hours')
    await wrapper.find('[data-test="recipe-enabled"]').trigger('click')
    await wrapper.find('[data-test="add-recipe"]').trigger('click')
    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(2)
    await wrapper.findAll('[data-test="delete-recipe"]')[1].trigger('click')
    await wrapper.find('[data-test="role-save"]').trigger('click')
    const payload = wrapper.emitted('save')?.[0]?.[0] as any
    expect(payload.recipes[0]).toMatchObject({ id: 'daily', name: 'Morning health', queryTemplate: 'last 24 hours', enabled: false })
    expect(wrapper.text()).not.toContain('preview session only')
  })

  it('renders server sections, provenance IDs, and truncation in the preview drawer', () => {
    const bundle = {
      role, profileMapping: { profileName: 'default', stale: false }, recipe: { id: 'daily', name: 'Daily' }, generatedAt: '', query: '',
      appliedScope: role.dataScope, appliedLimits: { perSection: 10, totalCharacters: 4000 },
      sections: { subject: [{ name: 'Alex' }], observations: [], events: [], goals: [], constraints: [], entities: [], relations: [] },
      sourceRecordIds: { subject: ['subject-1'] }, provenance: { subject: [{ recordId: 'subject-1', source: 'twin', sourceId: 'source-1' }] },
      truncated: { total: true, sections: { subject: true } }, renderedInstructions: 'server-rendered context',
    } as any
    const wrapper = mount(AssistantRolePreviewDrawer, { props: { show: true, bundle } })
    expect(wrapper.find('[data-test="server-context-bundle"]').text()).toContain('server-rendered context')
    expect(wrapper.text()).toContain('subject-1')
    expect(wrapper.text()).toContain('source-1')
    expect(wrapper.find('[data-test="preview-truncated"]').exists()).toBe(true)
  })
})
