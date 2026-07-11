<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchAssistantRole } from '@/api/hermes/assistant-roles'
import type { AssistantRoleDetail, AssistantRoleInput, AssistantRoleSummary, ContextRecipe, ContextRecipeInput, RoleContextBundle } from '@/api/hermes/assistant-roles'
import { useAssistantRolesStore } from '@/stores/hermes/assistant-roles'
import { useProfilesStore } from '@/stores/hermes/profiles'
import AssistantRoleEditor from './AssistantRoleEditor.vue'
import AssistantRolePreviewDrawer from './AssistantRolePreviewDrawer.vue'
import { useAssistantRoleMessages } from './assistant-role-messages'

const store = useAssistantRolesStore()
const profilesStore = useProfilesStore()
const dialog = useDialog()
const message = useMessage()
const { locale } = useI18n()
const { messages: m } = useAssistantRoleMessages(locale)
const detail = ref<AssistantRoleDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const editorMode = ref<'create' | 'edit'>('edit')
const editorRoleId = ref<string | null>(null)
const editorOpen = ref(false)
const previewOpen = ref(false)
const previewBundle = ref<RoleContextBundle | null>(null)
const previewRecipeId = ref('')
const previewQuery = ref('')
let detailSequence = 0
const profileNames = computed(() => profilesStore.profiles.map(profile => profile.name))

function blankRole(): AssistantRoleDetail {
  const now = new Date().toISOString()
  return { id: '', name: '', description: '', persona: '', builtIn: false, enabled: true, dataScope: { domains: [], sections: [], includeProvenance: true }, capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' }, decisionAuthority: {}, spendingLimits: {}, memoryNamespace: '', escalationRules: [], createdAt: now, updatedAt: now, profileMappings: [], primaryProfileName: null, mappingStale: false, recipeCount: 0, recipes: [] }
}

async function loadDetail(id: string | null): Promise<AssistantRoleDetail | null> {
  const sequence = ++detailSequence
  detailError.value = null
  detail.value = null
  if (!id) return null
  detailLoading.value = true
  try {
    const next = await fetchAssistantRole(id)
    if (sequence !== detailSequence || next.id !== id) return null
    detail.value = next
    previewRecipeId.value = next.recipes.find(recipe => recipe.enabled)?.id ?? ''
    return next
  }
  catch (cause) { if (sequence === detailSequence) detailError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (sequence === detailSequence) detailLoading.value = false }
  return null
}

async function refresh(): Promise<void> {
  try { await store.fetchRoles(); await loadDetail(store.selectedRoleId) } catch { /* store exposes a safe error */ }
}
onMounted(async () => { if (!profilesStore.profiles.length) await profilesStore.fetchHermesProfiles(); await refresh() })

function selectRole(role: AssistantRoleSummary): void { store.selectedRoleId = role.id; void loadDetail(role.id) }
function openCreate(): void { detail.value = blankRole(); editorRoleId.value = null; editorMode.value = 'create'; editorOpen.value = true }
async function openEdit(role: AssistantRoleSummary): Promise<void> { editorOpen.value = false; editorRoleId.value = null; store.selectedRoleId = role.id; const loaded = await loadDetail(role.id); if (!loaded) return; editorRoleId.value = loaded.id; editorMode.value = 'edit'; editorOpen.value = true }
async function toggleRole(role: AssistantRoleSummary, enabled: boolean): Promise<void> { try { const updated = await store.updateRole(role.id, { enabled }); if (store.selectedRoleId === role.id) detail.value = updated } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
async function cloneRole(role: AssistantRoleSummary): Promise<void> { try { const cloned = await store.cloneRole(role.id, { name: `${role.name} Copy` }); store.selectedRoleId = cloned.id; await loadDetail(cloned.id); message.success(m.value.clone) } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
function deleteRole(role: AssistantRoleSummary): void {
  if (role.builtIn) return
  dialog.warning({ title: m.value.delete, content: role.name, positiveText: m.value.delete, negativeText: m.value.cancel, async onPositiveClick() { try { detail.value = null; previewRecipeId.value = ''; await store.deleteRole(role.id); await loadDetail(store.selectedRoleId); message.success(m.value.delete) } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } } })
}
type RecipeDraft = ContextRecipeInput & { id?: string; builtIn?: boolean }
function recipeInput(recipe: RecipeDraft): ContextRecipeInput {
  return { ...(recipe.id ? { id: recipe.id } : {}), name: recipe.name, description: recipe.description, enabled: recipe.enabled, domains: recipe.domains, sections: recipe.sections, queryTemplate: recipe.queryTemplate, limits: recipe.limits }
}
async function syncRecipes(roleId: string, before: ContextRecipe[], after: RecipeDraft[]): Promise<void> {
  const retained = new Set(after.flatMap(recipe => recipe.id ? [recipe.id] : []))
  for (const recipe of before) if (!recipe.builtIn && !retained.has(recipe.id)) await store.deleteRecipe(roleId, recipe.id)
  for (const recipe of after) {
    const input = recipeInput(recipe)
    if (recipe.id && before.some(existing => existing.id === recipe.id)) { const { id: _id, ...patch } = input; await store.updateRecipe(roleId, recipe.id, patch) }
    else await store.createRecipe(roleId, input)
  }
}
async function save(payload: { role: AssistantRoleInput; profileName: string | null; recipes: RecipeDraft[] }): Promise<void> {
  const original = editorMode.value === 'edit' ? detail.value : null
  if (editorMode.value === 'edit' && (!original?.id || original.id !== editorRoleId.value || original.id !== store.selectedRoleId)) { editorOpen.value = false; return }
  let savedRoleId: string | null = null
  try {
    const saved = editorMode.value === 'create' ? await store.createRole(payload.role) : await store.updateRole(original!.id, payload.role)
    savedRoleId = saved.id
    if (editorMode.value === 'create') {
      editorMode.value = 'edit'
      editorRoleId.value = saved.id
      store.selectedRoleId = saved.id
      const createdDetail = await loadDetail(saved.id)
      if (!createdDetail) throw new Error('Created role detail could not be reloaded')
    }
    await store.updateProfileMapping(saved.id, payload.profileName)
    await syncRecipes(saved.id, original?.recipes ?? [], payload.recipes)
    editorOpen.value = false
    await loadDetail(saved.id)
    message.success(m.value.save)
  } catch (cause) {
    if (savedRoleId) { editorRoleId.value = savedRoleId; await loadDetail(savedRoleId) }
    message.error(`${m.value.partialSave} ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
async function preview(role: AssistantRoleSummary): Promise<void> { try { store.selectedRoleId = role.id; if (detail.value?.id !== role.id) await loadDetail(role.id); previewBundle.value = await store.previewContext(role.id, { ...(previewQuery.value.trim() ? { query: previewQuery.value.trim() } : {}), ...(previewRecipeId.value ? { recipeId: previewRecipeId.value } : {}) }); previewOpen.value = true } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
</script>

<template>
  <section class="roles-panel">
    <div class="toolbar"><NAlert type="warning">{{ m.phase3Warning }}</NAlert><NButton data-test="create-role" type="primary" @click="openCreate">{{ m.createRole }}</NButton></div>
    <NAlert v-if="store.error || detailError" type="error"><span>{{ store.error || detailError }}</span> <NButton data-test="roles-retry" size="tiny" @click="refresh">{{ m.retry }}</NButton></NAlert>
    <div v-if="store.loading && !store.roles.length" data-test="roles-loading"><NSpin :show="true">{{ m.loading }}</NSpin></div>
    <NEmpty v-else-if="!store.roles.length" data-test="roles-empty" :description="m.empty" />
    <div v-else class="role-layout">
      <ul class="role-list" aria-label="Assistant roles">
        <li v-for="role in store.roles" :key="role.id" class="role-card" :class="{ selected: store.selectedRoleId === role.id }">
          <button class="role-select" type="button" :data-test="`select-role-${role.id}`" :aria-current="store.selectedRoleId === role.id ? 'true' : undefined" @click="selectRole(role)"><span class="role-heading"><strong>{{ role.name }}</strong><NTag size="small" :type="role.builtIn ? 'info' : 'default'">{{ role.builtIn ? m.builtIn : m.custom }}</NTag></span><span class="role-description">{{ role.description }}</span><span v-if="role.mappingStale" class="stale-warning">{{ m.staleMapping }}</span><span class="role-meta"><span>{{ role.primaryProfileName || m.noProfile }}</span><span>{{ role.recipeCount }} {{ m.recipes }}</span></span></button>
          <div class="role-actions" @click.stop>
            <NSwitch :data-test="`toggle-${role.id}`" :aria-label="`${role.enabled ? m.disabled : m.enabled}: ${role.name}`" :value="role.enabled" :loading="store.saving" @update:value="toggleRole(role, $event)" />
            <NButton :data-test="`preview-${role.id}`" :aria-label="`${m.preview}: ${role.name}`" size="tiny" @click="preview(role)">{{ m.preview }}</NButton><NButton :data-test="`edit-${role.id}`" :aria-label="`${m.edit}: ${role.name}`" size="tiny" @click="openEdit(role)">{{ m.edit }}</NButton><NButton :data-test="`clone-${role.id}`" :aria-label="`${m.clone}: ${role.name}`" size="tiny" @click="cloneRole(role)">{{ m.clone }}</NButton><NButton :data-test="`delete-${role.id}`" :aria-label="`${m.delete}: ${role.name}`" size="tiny" type="error" :disabled="role.builtIn" @click="deleteRole(role)">{{ m.delete }}</NButton>
          </div>
        </li>
      </ul>
      <aside class="role-detail" data-test="role-detail" :data-role-id="detail?.id || ''"><NSpin :show="detailLoading"><template v-if="detail"><h3>{{ detail.name }}</h3><p>{{ detail.persona }}</p><dl><dt>{{ m.domains }}</dt><dd>{{ detail.dataScope.domains.join(', ') || '—' }}</dd><dt>{{ m.sections }}</dt><dd>{{ detail.dataScope.sections.join(', ') || '—' }}</dd><dt>{{ m.profileMapping }}</dt><dd>{{ detail.primaryProfileName || m.noProfile }}</dd></dl><label>{{ m.recipes }}<select data-test="preview-recipe" v-model="previewRecipeId"><option value="">—</option><option v-for="recipe in detail.recipes.filter(item => item.enabled)" :key="recipe.id" :value="recipe.id">{{ recipe.name }}</option></select></label><label>{{ m.query }}<NInput v-model:value="previewQuery" /></label></template></NSpin></aside>
    </div>
    <AssistantRoleEditor :show="editorOpen" :mode="editorMode" :role="detail" :profile-names="profileNames" :saving="store.saving" @close="editorOpen = false" @save="save" />
    <AssistantRolePreviewDrawer :show="previewOpen" :bundle="previewBundle" @close="previewOpen = false" />
  </section>
</template>

<style scoped lang="scss">
.roles-panel { display:flex; flex-direction:column; gap:14px; } .toolbar { display:flex; gap:12px; align-items:center; justify-content:space-between; } .toolbar :deep(.n-alert) { flex:1; } .role-layout { display:grid; grid-template-columns:minmax(360px,1.5fr) minmax(260px,1fr); gap:16px; } .role-list { display:flex; flex-direction:column; gap:10px; list-style:none; padding:0; margin:0; } .role-card,.role-detail { padding:14px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-color); } .role-card.selected { border-color:var(--primary-color); } .role-select { width:100%; display:flex; flex-direction:column; gap:8px; padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; } .role-heading,.role-meta,.role-actions { display:flex; align-items:center; gap:8px; } .role-heading,.role-meta { width:100%; justify-content:space-between; } .role-description { opacity:.75; } .stale-warning { color:var(--warning-color); font-size:12px; } .role-meta { font-size:12px; opacity:.7; } .role-actions { flex-wrap:wrap; margin-top:12px; } dl { display:grid; grid-template-columns:max-content 1fr; gap:8px; } dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; } @media(max-width:800px){.role-layout{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column}}
</style>
