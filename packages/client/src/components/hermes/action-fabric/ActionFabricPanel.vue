<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ActionAuditEventDto, ActionCapabilityDto, ActionWorkflowSummaryDto } from '@/api/hermes/action-fabric'
import { useActionFabricStore } from '@/stores/hermes/action-fabric'
import { useAssistantRolesStore } from '@/stores/hermes/assistant-roles'
import CapabilityRegistryPanel from './CapabilityRegistryPanel.vue'
import EmergencyStopPanel from './EmergencyStopPanel.vue'
import WorkflowDetailDrawer from './WorkflowDetailDrawer.vue'
import { useActionFabricMessages } from './action-fabric-messages'

const store = useActionFabricStore()
const auditState = store as unknown as { audit: ActionAuditEventDto[] }
const rolesStore = useAssistantRolesStore()
const { locale } = useI18n()
const { messages: m } = useActionFabricMessages(locale)
const announcement = ref('')
const refreshDegraded = ref(false)
const auditDegraded = ref(false)
const selectedWorkflowAudit = ref<ActionAuditEventDto[]>([])
let detailOpener: HTMLElement | null = null
let refreshSequence = 0
let selectionSequence = 0
let auditGeneration = 0
let pendingAuditToken: number | null = null
const runningStates = new Set(['draft', 'policy_check', 'preparing', 'executing', 'verifying', 'retrying', 'compensating'])
const completedStates = new Set(['succeeded', 'denied', 'cancelled', 'compensated'])
const reversibleIds = computed<ReadonlySet<string>>(() => {
  const ids: string[] = store.capabilities.filter(item => item.reversible).map(item => item.id)
  return new Set<string>(ids)
})
const groups = computed(() => ({
  running: store.workflows.filter(item => runningStates.has(item.state)),
  waiting: store.workflows.filter(item => item.state === 'waiting_user'),
  failed: store.workflows.filter(item => item.state === 'failed' || item.state === 'dead_letter'),
  reversible: store.workflows.filter(item => item.state === 'succeeded' && !item.compensationIntentId && reversibleIds.value.has(item.capabilityId)),
  completed: store.workflows.filter(item => completedStates.has(item.state) && !(item.state === 'succeeded' && !item.compensationIntentId && reversibleIds.value.has(item.capabilityId))),
}))
const groupDefinitions = computed(() => [
  { key: 'running' as const, label: m.value.running }, { key: 'waiting' as const, label: m.value.waiting },
  { key: 'failed' as const, label: m.value.failed }, { key: 'reversible' as const, label: m.value.reversible },
  { key: 'completed' as const, label: m.value.completed },
])
const selectedCapability = computed<ActionCapabilityDto | null>(() => {
  const capabilityId: string | undefined = store.selectedWorkflow?.capabilityId
  if (!capabilityId) return null
  const capabilities: ActionCapabilityDto[] = store.capabilities
  return capabilities.find(item => item.id === capabilityId) ?? null
})
const statusText = computed(() => store.error === 'ACTION_FABRIC_REFRESH_FAILED' ? m.value.refreshWarning : store.error ? `${m.value.degraded} ${store.error}` : refreshDegraded.value || auditDegraded.value ? m.value.degraded : announcement.value)

function invalidateSelectedAudit(): void {
  auditGeneration += 1
  pendingAuditToken = null
  selectedWorkflowAudit.value = []
  auditDegraded.value = false
}
watch([() => store.selectedWorkflowId, () => store.selectedWorkflow?.id ?? null], ([selectedId, detailId], [previousId]) => {
  if (!selectedId || selectedId !== previousId || detailId !== selectedId) invalidateSelectedAudit()
}, { flush: 'sync' })

async function refresh(): Promise<void> {
  const sequence = ++refreshSequence
  announcement.value = ''
  const results = await Promise.allSettled([store.loadCapabilities(), store.loadExecutors(), store.loadWorkflows(), store.loadControl(), rolesStore.fetchRoles()])
  if (sequence === refreshSequence) refreshDegraded.value = results.some(result => result.status === 'rejected')
}
onMounted(() => { void refresh() })

async function openWorkflow(workflow: ActionWorkflowSummaryDto, event: MouseEvent): Promise<void> {
  const sequence = ++selectionSequence
  invalidateSelectedAudit()
  detailOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  try {
    await store.selectWorkflow(workflow.id)
    if (sequence !== selectionSequence || store.selectedWorkflowId !== workflow.id) return
    await refreshSelectedWorkflowAudit(workflow.id, sequence)
  } catch { /* stores expose safe authoritative errors */ }
}

function hasCurrentSelection(id: string, sequence: number): boolean {
  return sequence === selectionSequence && store.selectedWorkflowId === id && store.selectedWorkflow?.id === id
}
async function refreshSelectedWorkflowAudit(id: string, sequence: number): Promise<boolean> {
  invalidateSelectedAudit()
  const auditToken = auditGeneration
  pendingAuditToken = auditToken
  try {
    try {
      await store.loadAudit({ aggregateType: 'workflow', aggregateId: id, limit: 100 })
    } catch {
      if (hasCurrentSelection(id, sequence) && auditToken === auditGeneration) auditDegraded.value = true
      return false
    }
    if (!hasCurrentSelection(id, sequence) || auditToken !== auditGeneration) return false
    const currentAudit = auditState.audit
    if (!currentAudit.every(event => event.aggregateType === 'workflow' && event.aggregateId === id)) {
      selectedWorkflowAudit.value = []
      auditDegraded.value = true
      return false
    }
    selectedWorkflowAudit.value = currentAudit.slice(0, 100)
    auditDegraded.value = false
    return true
  } finally {
    if (pendingAuditToken === auditToken) pendingAuditToken = null
  }
}
async function closeDrawer(): Promise<void> {
  selectionSequence += 1
  invalidateSelectedAudit()
  await store.selectWorkflow(null)
  await nextTick()
  detailOpener?.focus()
}
async function mutate(operation: () => Promise<unknown>): Promise<void> {
  announcement.value = ''
  try { await operation(); announcement.value = m.value.updated } catch { /* store error remains authoritative */ }
}
async function mutateControl(operation: () => Promise<unknown>): Promise<void> {
  if (pendingAuditToken !== null) {
    auditGeneration += 1
    pendingAuditToken = null
    selectedWorkflowAudit.value = []
    auditDegraded.value = true
  }
  await mutate(operation)
}
async function mutateWorkflow(id: string, operation: () => Promise<unknown>): Promise<void> {
  const sequence = selectionSequence
  announcement.value = ''
  try { await operation() } catch { return }
  if (!hasCurrentSelection(id, sequence)) return
  if (await refreshSelectedWorkflowAudit(id, sequence)) announcement.value = m.value.updated
}
</script>

<template>
  <section class="fabric-panel" aria-labelledby="action-center-title">
    <NAlert type="info" data-test="executor-boundary">{{ m.banner }}</NAlert>
    <div class="section-heading"><h3 id="action-center-title">{{ m.actionCenter }}</h3><NButton data-test="action-retry" size="small" @click="refresh">{{ m.refresh }}</NButton></div>
    <p role="status" aria-live="polite">{{ statusText }}</p>
    <div v-if="store.loading && !store.workflows.length" data-test="action-loading"><NSpin :show="true">{{ m.loading }}</NSpin></div>
    <NEmpty v-else-if="!store.workflows.length" data-test="action-empty" :description="m.empty" />
    <div v-else class="workflow-groups">
      <section v-for="definition in groupDefinitions" :key="definition.key" :data-test="`group-${definition.key}`" class="workflow-group">
        <h4>{{ definition.label }} <NTag size="small">{{ groups[definition.key].length }}</NTag></h4>
        <ul><li v-for="workflow in groups[definition.key].slice(0, 100)" :key="workflow.id"><button type="button" :data-test="`workflow-${workflow.id}`" :aria-label="`${m.viewDetails}: ${workflow.goal}`" @click="openWorkflow(workflow, $event)"><strong>{{ workflow.goal }}</strong><span>{{ workflow.id }}</span><span>{{ workflow.state }} · {{ workflow.capabilityId }}</span></button></li></ul>
      </section>
    </div>
    <NAlert v-if="store.selectedWorkflowId && !store.selectedWorkflow && !store.loading" data-test="action-stale-selection" type="warning">{{ m.staleSelection }}</NAlert>
    <CapabilityRegistryPanel :capabilities="store.capabilities" :executors="store.executors" :roles="rolesStore.roles" />
    <EmergencyStopPanel :control="store.control" :saving="store.saving" @update="mutateControl(() => store.updateEmergencyStop($event))" />
    <WorkflowDetailDrawer :show="Boolean(store.selectedWorkflowId)" :workflow="store.selectedWorkflow" :capability="selectedCapability" :audit="selectedWorkflowAudit" :saving="store.saving" @close="closeDrawer" @approve="store.selectedWorkflowId && mutateWorkflow(store.selectedWorkflowId, () => store.approveWorkflow(store.selectedWorkflowId!))" @reject="store.selectedWorkflowId && mutateWorkflow(store.selectedWorkflowId, () => store.rejectWorkflow(store.selectedWorkflowId!, $event))" @retry="store.selectedWorkflowId && mutateWorkflow(store.selectedWorkflowId, () => store.retryWorkflow(store.selectedWorkflowId!))" @cancel="store.selectedWorkflowId && mutateWorkflow(store.selectedWorkflowId, () => store.cancelWorkflow(store.selectedWorkflowId!, $event))" @compensate="store.selectedWorkflowId && mutateWorkflow(store.selectedWorkflowId, () => store.compensateWorkflow(store.selectedWorkflowId!, $event))" />
  </section>
</template>

<style scoped lang="scss">
.fabric-panel { display:flex; flex-direction:column; gap:18px; } .section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; } h3,h4,p { margin:0; } .workflow-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; } .workflow-group { min-width:0; padding:12px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-color); } .workflow-group h4 { display:flex; justify-content:space-between; gap:8px; } ul { list-style:none; padding:0; margin:10px 0 0; display:flex; flex-direction:column; gap:8px; } li>button { width:100%; display:flex; flex-direction:column; gap:4px; padding:10px; border:1px solid var(--border-color); border-radius:8px; background:transparent; color:inherit; text-align:left; cursor:pointer; overflow-wrap:anywhere; } li>button span { font-size:12px; opacity:.75; } @media(max-width:700px){.workflow-groups{grid-template-columns:1fr}}
</style>
