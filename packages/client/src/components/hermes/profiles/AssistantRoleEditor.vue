<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal, NSwitch, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { TWIN_CONTEXT_SECTIONS, TWIN_DOMAINS } from '@/api/hermes/assistant-roles'
import type { AssistantRoleDetail, AssistantRoleInput, ContextRecipe } from '@/api/hermes/assistant-roles'
import { useAssistantRoleMessages } from './assistant-role-messages'

const props = defineProps<{ show: boolean; mode: 'create' | 'edit'; role: AssistantRoleDetail | null; profileNames: string[]; saving?: boolean }>()
const emit = defineEmits<{ close: []; save: [payload: { role: AssistantRoleInput; profileName: string | null; recipes: ContextRecipe[] }] }>()
const { locale } = useI18n()
const { messages: m } = useAssistantRoleMessages(locale)

const form = reactive({ name: '', description: '', persona: '', enabled: true, memoryNamespace: '', domains: [] as string[], sections: [] as string[], includeProvenance: true, allow: '', deny: '', profileName: '', decisionAuthority: '{}', spendingLimits: '{}', escalationRules: '[]' })
const recipes = ref<ContextRecipe[]>([])
const validationError = ref('')
const title = computed(() => props.mode === 'create' ? m.value.createRole : `${m.value.edit}: ${props.role?.name ?? ''}`)

function reset(): void {
  const role = props.role
  Object.assign(form, {
    name: role?.name ?? '', description: role?.description ?? '', persona: role?.persona ?? '', enabled: role?.enabled ?? true,
    memoryNamespace: role?.memoryNamespace ?? '', domains: [...(role?.dataScope.domains ?? [])], sections: [...(role?.dataScope.sections ?? [])],
    includeProvenance: role?.dataScope.includeProvenance ?? true, allow: role?.capabilityScope.allow.join(', ') ?? '', deny: role?.capabilityScope.deny.join(', ') ?? '',
    profileName: role?.primaryProfileName ?? '', decisionAuthority: JSON.stringify(role?.decisionAuthority ?? {}, null, 2), spendingLimits: JSON.stringify(role?.spendingLimits ?? {}, null, 2), escalationRules: JSON.stringify(role?.escalationRules ?? [], null, 2),
  })
  recipes.value = (role?.recipes ?? []).map(recipe => ({ ...recipe, limits: { ...recipe.limits } }))
  validationError.value = ''
}
watch(() => [props.show, props.role] as const, reset, { immediate: true })

function toggle(list: string[], value: string, checked: boolean): void {
  const index = list.indexOf(value)
  if (checked && index < 0) list.push(value)
  if (!checked && index >= 0) list.splice(index, 1)
}
function csv(value: string): string[] { return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] }
function clamp(value: unknown, min: number, max: number): number { const number = Number(value); return Math.min(max, Math.max(min, Number.isFinite(number) ? Math.round(number) : min)) }
function updateLimit(recipe: ContextRecipe, field: 'perSection' | 'totalCharacters', value: unknown): void { recipe.limits[field] = clamp(value, field === 'perSection' ? 1 : 1000, field === 'perSection' ? 50 : 40000) }

function save(): void {
  if (!form.name.trim()) { validationError.value = m.value.nameRequired; return }
  if (!form.persona.trim()) { validationError.value = m.value.personaRequired; return }
  if (!form.memoryNamespace.trim()) { validationError.value = m.value.memoryRequired; return }
  try {
    const decisionAuthority = JSON.parse(form.decisionAuthority)
    const spendingLimits = JSON.parse(form.spendingLimits)
    const escalationRules = JSON.parse(form.escalationRules)
    if (!decisionAuthority || Array.isArray(decisionAuthority) || !spendingLimits || Array.isArray(spendingLimits) || !Array.isArray(escalationRules)) throw new Error('shape')
    validationError.value = ''
    emit('save', { role: { name: form.name.trim(), description: form.description.trim(), persona: form.persona.trim(), enabled: form.enabled, dataScope: { domains: form.domains as any, sections: form.sections as any, includeProvenance: form.includeProvenance }, capabilityScope: { allow: csv(form.allow), deny: csv(form.deny), enforcement: 'declarative_phase_2' }, decisionAuthority, spendingLimits, memoryNamespace: form.memoryNamespace.trim(), escalationRules }, profileName: form.profileName || null, recipes: recipes.value })
  } catch { validationError.value = m.value.invalidJson }
}
</script>

<template>
  <NModal :show="show" preset="card" :title="title" :style="{ width: 'min(920px, calc(100vw - 32px))' }" @update:show="!$event && emit('close')">
    <div class="editor-grid">
      <section><h3>{{ m.identity }}</h3>
        <label>{{ m.name }}<NInput data-test="role-name" v-model:value="form.name" :disabled="role?.builtIn" /></label>
        <label>{{ m.description }}<NInput v-model:value="form.description" /></label>
        <label>{{ m.persona }}<NInput v-model:value="form.persona" type="textarea" /></label>
        <label>{{ m.memoryNamespace }}<NInput v-model:value="form.memoryNamespace" /></label>
        <label>{{ m.profileMapping }}<select data-test="role-profile-mapping" v-model="form.profileName"><option value="">{{ m.noProfile }}</option><option v-for="name in profileNames" :key="name" :value="name">{{ name }}</option></select></label>
        <label class="inline"><NSwitch v-model:value="form.enabled" /> {{ form.enabled ? m.enabled : m.disabled }}</label>
      </section>
      <section><h3>{{ m.dataScope }}</h3><h4>{{ m.domains }}</h4><div class="check-grid"><label v-for="domain in TWIN_DOMAINS" :key="domain"><input :data-test="`role-domain-${domain}`" type="checkbox" :checked="form.domains.includes(domain)" @change="toggle(form.domains, domain, ($event.target as HTMLInputElement).checked)"> {{ domain }}</label></div>
        <h4>{{ m.sections }}</h4><div class="check-grid"><label v-for="section in TWIN_CONTEXT_SECTIONS" :key="section"><input :data-test="`role-section-${section}`" type="checkbox" :checked="form.sections.includes(section)" @change="toggle(form.sections, section, ($event.target as HTMLInputElement).checked)"> {{ section }}</label></div>
        <label class="inline"><input type="checkbox" v-model="form.includeProvenance"> {{ m.includeProvenance }}</label>
      </section>
      <section><h3>{{ m.capability }}</h3><NAlert type="warning">{{ m.phase3Warning }}</NAlert><label>{{ m.allow }}<NInput v-model:value="form.allow" /></label><label>{{ m.deny }}<NInput v-model:value="form.deny" /></label></section>
      <section><h3>{{ m.metadata }}</h3><label>{{ m.decisionAuthority }}<textarea v-model="form.decisionAuthority" /></label><label>{{ m.spendingLimits }}<textarea v-model="form.spendingLimits" /></label><label>{{ m.escalationRules }}<textarea v-model="form.escalationRules" /></label></section>
      <section class="wide"><h3>{{ m.recipes }} <NTag size="small">{{ recipes.length }}</NTag></h3><p class="muted">{{ m.recipeLimitsNotice }}</p><article v-for="recipe in recipes" :key="recipe.id" class="recipe"><strong>{{ recipe.name }}</strong><label>{{ m.perSection }}<input data-test="recipe-per-section" type="number" min="1" max="50" :value="recipe.limits.perSection" @change="updateLimit(recipe, 'perSection', ($event.target as HTMLInputElement).value)"></label><label>{{ m.totalCharacters }}<input data-test="recipe-total-characters" type="number" min="1000" max="40000" :value="recipe.limits.totalCharacters" @change="updateLimit(recipe, 'totalCharacters', ($event.target as HTMLInputElement).value)"></label></article></section>
    </div>
    <NAlert v-if="validationError" data-test="role-validation-error" type="error">{{ validationError }}</NAlert>
    <template #footer><div class="footer"><NButton @click="emit('close')">{{ m.cancel }}</NButton><NButton data-test="role-save" type="primary" :loading="saving" @click="save">{{ m.save }}</NButton></div></template>
  </NModal>
</template>

<style scoped lang="scss">
.editor-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; max-height:68vh; overflow:auto; } section { display:flex; flex-direction:column; gap:10px; } h3,h4,p { margin:0; } label { display:flex; flex-direction:column; gap:5px; font-size:13px; } .inline { flex-direction:row; align-items:center; } .check-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; } .check-grid label { flex-direction:row; } select,textarea,input[type='number'] { border:1px solid var(--border-color); border-radius:6px; padding:7px; background:var(--card-color); color:inherit; } textarea { min-height:72px; } .wide { grid-column:1/-1; } .recipe { display:flex; align-items:end; gap:12px; padding:10px; border:1px solid var(--border-color); border-radius:8px; } .muted { opacity:.7; font-size:12px; } .footer { display:flex; justify-content:flex-end; gap:8px; } @media(max-width:700px){.editor-grid{grid-template-columns:1fr}.wide{grid-column:auto}}
</style>
