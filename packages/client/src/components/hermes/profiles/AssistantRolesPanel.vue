<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchAssistantRole } from '@/api/hermes/assistant-roles'
import type { AssistantRoleDetail, AssistantRoleInput, AssistantRoleSummary, ContextRecipe, RoleContextBundle } from '@/api/hermes/assistant-roles'
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
const editorOpen = ref(false)
const previewOpen = ref(false)
const previewBundle = ref<RoleContextBundle | null>(null)
let detailSequence = 0
const profileNames = computed(() => profilesStore.profiles.map(profile => profile.name))

function blankRole(): AssistantRoleDetail {
  const now = new Date().toISOString()
  return { id: '', name: '', description: '', persona: '', builtIn: false, enabled: true, dataScope: { domains: [], sections: [], includeProvenance: true }, capabilityScope: { allow: [], deny: [], enforcement: 'declarative_phase_2' }, decisionAuthority: {}, spendingLimits: {}, memoryNamespace: '', escalationRules: [], createdAt: now, updatedAt: now, profileMappings: [], primaryProfileName: null, mappingStale: false, recipeCount: 0, recipes: [] }
}

async function loadDetail(id: string | null): Promise<void> {
  const sequence = ++detailSequence
  detailError.value = null
  if (!id) { detail.value = null; return }
  detailLoading.value = true
  try { const next = await fetchAssistantRole(id); if (sequence === detailSequence) detail.value = next }
  catch (cause) { if (sequence === detailSequence) detailError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (sequence === detailSequence) detailLoading.value = false }
}
watch(() => store.selectedRoleId, id => { void loadDetail(id) })

async function refresh(): Promise<void> {
  try { await store.fetchRoles(); await loadDetail(store.selectedRoleId) } catch { /* store exposes a safe error */ }
}
onMounted(async () => { if (!profilesStore.profiles.length) await profilesStore.fetchHermesProfiles(); await refresh() })

function selectRole(role: AssistantRoleSummary): void { store.selectedRoleId = role.id; void loadDetail(role.id) }
function openCreate(): void { detail.value = blankRole(); editorMode.value = 'create'; editorOpen.value = true }
async function openEdit(role: AssistantRoleSummary): Promise<void> { selectRole(role); await loadDetail(role.id); editorMode.value = 'edit'; editorOpen.value = true }
async function toggleRole(role: AssistantRoleSummary, enabled: boolean): Promise<void> { try { detail.value = await store.updateRole(role.id, { enabled }) } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
async function cloneRole(role: AssistantRoleSummary): Promise<void> { try { await store.cloneRole(role.id, { name: `${role.name} Copy` }); message.success(m.value.clone) } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
function deleteRole(role: AssistantRoleSummary): void {
  if (role.builtIn) return
  dialog.warning({ title: m.value.delete, content: role.name, positiveText: m.value.delete, negativeText: m.value.cancel, async onPositiveClick() { try { await store.deleteRole(role.id); message.success(m.value.delete) } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } } })
}
async function save(payload: { role: AssistantRoleInput; profileName: string | null; recipes: ContextRecipe[] }): Promise<void> {
  try {
    const saved = editorMode.value === 'create' ? await store.createRole(payload.role) : await store.updateRole(detail.value!.id, payload.role)
    await store.updateProfileMapping(saved.id, payload.profileName)
    editorOpen.value = false
    await loadDetail(saved.id)
    message.success(m.value.save)
  } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) }
}
async function preview(role: AssistantRoleSummary): Promise<void> { try { store.selectedRoleId = role.id; previewBundle.value = await store.previewContext(role.id, {}); previewOpen.value = true } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)) } }
</script>

<template>
  <section class="roles-panel">
    <div class="toolbar"><NAlert type="warning">{{ m.phase3Warning }}</NAlert><NButton type="primary" @click="openCreate">{{ m.createRole }}</NButton></div>
    <NAlert v-if="store.error || detailError" type="error"><span>{{ store.error || detailError }}</span> <NButton data-test="roles-retry" size="tiny" @click="refresh">{{ m.retry }}</NButton></NAlert>
    <div v-if="store.loading && !store.roles.length" data-test="roles-loading"><NSpin :show="true">{{ m.loading }}</NSpin></div>
    <NEmpty v-else-if="!store.roles.length" data-test="roles-empty" :description="m.empty" />
    <div v-else class="role-layout">
      <div class="role-list" role="list">
        <article v-for="role in store.roles" :key="role.id" class="role-card" :class="{ selected: store.selectedRoleId === role.id }" role="listitem" @click="selectRole(role)">
          <div class="role-heading"><strong>{{ role.name }}</strong><NTag size="small" :type="role.builtIn ? 'info' : 'default'">{{ role.builtIn ? m.builtIn : m.custom }}</NTag></div><p>{{ role.description }}</p>
          <NAlert v-if="role.mappingStale" type="warning">{{ m.staleMapping }}</NAlert>
          <div class="role-meta"><span>{{ role.primaryProfileName || m.noProfile }}</span><span>{{ role.recipeCount }} {{ m.recipes }}</span></div>
          <div class="role-actions" @click.stop>
            <NSwitch :data-test="`toggle-${role.id}`" :value="role.enabled" :loading="store.saving" @update:value="toggleRole(role, $event)" />
            <NButton :data-test="`preview-${role.id}`" size="tiny" @click="preview(role)">{{ m.preview }}</NButton><NButton :data-test="`edit-${role.id}`" size="tiny" @click="openEdit(role)">{{ m.edit }}</NButton><NButton :data-test="`clone-${role.id}`" size="tiny" @click="cloneRole(role)">{{ m.clone }}</NButton><NButton :data-test="`delete-${role.id}`" size="tiny" type="error" :disabled="role.builtIn" @click="deleteRole(role)">{{ m.delete }}</NButton>
          </div>
        </article>
      </div>
      <aside class="role-detail"><NSpin :show="detailLoading"><template v-if="detail"><h3>{{ detail.name }}</h3><p>{{ detail.persona }}</p><dl><dt>{{ m.domains }}</dt><dd>{{ detail.dataScope.domains.join(', ') || '—' }}</dd><dt>{{ m.sections }}</dt><dd>{{ detail.dataScope.sections.join(', ') || '—' }}</dd><dt>{{ m.profileMapping }}</dt><dd>{{ detail.primaryProfileName || m.noProfile }}</dd></dl></template></NSpin></aside>
    </div>
    <AssistantRoleEditor :show="editorOpen" :mode="editorMode" :role="detail" :profile-names="profileNames" :saving="store.saving" @close="editorOpen = false" @save="save" />
    <AssistantRolePreviewDrawer :show="previewOpen" :bundle="previewBundle" @close="previewOpen = false" />
  </section>
</template>

<style scoped lang="scss">
.roles-panel { display:flex; flex-direction:column; gap:14px; } .toolbar { display:flex; gap:12px; align-items:center; justify-content:space-between; } .toolbar :deep(.n-alert) { flex:1; } .role-layout { display:grid; grid-template-columns:minmax(360px,1.5fr) minmax(260px,1fr); gap:16px; } .role-list { display:flex; flex-direction:column; gap:10px; } .role-card,.role-detail { padding:14px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-color); } .role-card { cursor:pointer; } .role-card.selected { border-color:var(--primary-color); } .role-heading,.role-meta,.role-actions { display:flex; align-items:center; gap:8px; } .role-heading { justify-content:space-between; } .role-card p { margin:8px 0; opacity:.75; } .role-meta { justify-content:space-between; font-size:12px; opacity:.7; } .role-actions { flex-wrap:wrap; margin-top:12px; } dl { display:grid; grid-template-columns:max-content 1fr; gap:8px; } dt { font-weight:600; } dd { margin:0; overflow-wrap:anywhere; } @media(max-width:800px){.role-layout{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column}}
</style>
