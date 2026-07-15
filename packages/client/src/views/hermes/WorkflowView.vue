<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NDrawer, NDrawerContent, NDropdown, NInput, NModal, NPopconfirm, NSelect, NSpace, NTooltip, useMessage, type DropdownOption } from 'naive-ui'
import {
  ConnectionLineType,
  MarkerType,
  VueFlow,
  useVueFlow,
  type Connection,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { useI18n } from 'vue-i18n'
import { buildWorkflowEvidenceRows, latestWorkflowNodeSession, type WorkflowEvidenceRow } from '@/utils/workflow-history'
import {
  inferWorkflowConditionValueType,
  parseWorkflowConditionValue,
  requiredWorkflowConditionValueType,
  serializeWorkflowConditionValueForType,
  workflowConditionNeedsValue,
  type WorkflowConditionValueType,
} from '@/utils/workflow-edge-condition'
import { workflowImportConfirmationText } from '@/utils/workflow-import'
import { createConnectedAgentTransaction, type CanvasTransaction } from '@/utils/workflow-canvas'
import WorkflowAgentNode from '@/components/hermes/workflow/WorkflowAgentNode.vue'
import WorkflowFieldHelp from '@/components/hermes/workflow/WorkflowFieldHelp.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { uploadRuntimeFiles } from '@/api/hermes/files'
import {
  approveWorkflowNode,
  batchDeleteWorkflows,
  createWorkflow as createWorkflowApi,
  cancelWorkflowImport,
  confirmWorkflowImport,
  deleteWorkflowRun,
  deleteWorkflow as deleteWorkflowApi,
  exportWorkflow,
  fetchWorkflowRun,
  listWorkflowRuns,
  previewWorkflowImport,
  listWorkflows as listWorkflowsApi,
  rerunWorkflowRunFromNode,
  runWorkflowNow,
  stopWorkflowRun,
  updateWorkflow as updateWorkflowApi,
  type WorkflowRunRecord,
  type WorkflowRecord,
  type WorkflowViewport,
} from '@/api/hermes/workflows'
import {
  disconnectWorkflowSocket,
  listWorkflowsSocket,
  onWorkflowStatusError,
  onWorkflowStatusUpdated,
  subscribeWorkflowStatuses,
  type WorkflowRuntimeState,
  type WorkflowRuntimeStatus,
} from '@/api/hermes/workflow-socket'
import { fetchSkills } from '@/api/hermes/skills'
import { fetchSession } from '@/api/hermes/sessions'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode } from '@/api/coding-agents'
import { buildWorkflowSkillOptions, workflowAgentToSkillTarget } from '@/utils/hermes/workflow-skills'
import type {
  WorkflowAgentNodeData,
  WorkflowAgentNodeEditableData,
  WorkflowNodeStatus,
  WorkflowSelectOption,
} from '@/components/hermes/workflow/types'
import type { AvailableModelGroup } from '@/api/hermes/system'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const { t } = useI18n()
const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const {
  screenToFlowCoordinate, getViewport, setViewport, setNodes, setEdges, updateNodeInternals,
  findNode, addSelectedNodes, removeSelectedElements,
} = useVueFlow('hermes-workflow')
const defaultViewport: WorkflowViewport = { x: 80, y: 80, zoom: 0.75 }
const workflowBodyRef = ref<HTMLElement | null>(null)
const workflowCanvasRef = ref<HTMLElement | null>(null)
const workflowImportInputRef = ref<HTMLInputElement | null>(null)
const workflowImportConfirmVisible = ref(false)
const workflowImportPreview = ref<Awaited<ReturnType<typeof previewWorkflowImport>> | null>(null)
const workflowImportProfile = ref('default')
const workflowImportConfirming = ref(false)
const WORKFLOW_CHAT_PANEL_MIN_WIDTH = 360
const WORKFLOW_CHAT_PANEL_DEFAULT_WIDTH = 560
const WORKFLOW_CANVAS_MIN_WIDTH = 360
const WORKFLOW_RUNS_PANEL_WIDTH = 280
const WORKFLOW_CHAT_PANEL_STORAGE_KEY = 'hermes.workflow.chatPanelWidth'
const WORKFLOW_NODE_DEFAULT_WIDTH = 300
const WORKFLOW_NODE_DEFAULT_HEIGHT = 550

interface WorkflowNode {
  id: string
  type: 'agent'
  position: { x: number; y: number }
  dragHandle: string
  style: { width: string; height: string }
  data: WorkflowAgentNodeData
}

interface WorkflowEdgeOrchestration {
  route: 'success' | 'failure' | 'always'
  condition?: { path: string; operator: string; value?: unknown }
  feedback?: { maxIterations: number; loopId?: string }
}

interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type: 'smoothstep'
  animated?: boolean
  markerEnd?: MarkerType
  data?: { orchestration?: WorkflowEdgeOrchestration }
}

interface WorkflowDocument {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport: WorkflowViewport
  nextNodeIndex: number
  updatedAt: number
}

const nextNodeIndex = ref(1)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuOpenedAt = ref(0)
const contextMenuTarget = ref<{ type: 'node' | 'edge'; id: string } | null>(null)
const edgeEditorVisible = ref(false)
const edgeEditorId = ref('')
const edgeEditorRoute = ref<'success' | 'failure' | 'always'>('success')
const edgeEditorConditionPath = ref('')
const edgeEditorConditionPathPreset = ref<'route-only' | 'output' | 'error' | 'custom'>('route-only')
const edgeEditorConditionOperator = ref('equals')
const edgeEditorConditionValueType = ref<WorkflowConditionValueType>('string')
const edgeEditorConditionValue = ref('')
const edgeEditorFeedback = ref(false)
const edgeEditorMaxIterations = ref('3')
const edgeEditorLoopId = ref('')
const LOOP_ID_AUTOMATIC = '__automatic__'
const workflowEdgeRouteOptions = computed(() => (['success', 'failure', 'always'] as const).map(value => ({
  value,
  label: t(`workflow.edgeEditor.routes.${value}`),
})))
const workflowEdgeOperatorValues = [
  'equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists',
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'in', 'not_in',
] as const
const workflowEdgeOperatorOptions = computed(() => workflowEdgeOperatorValues.map(value => ({
  value,
  label: t(`workflow.edgeEditor.operators.${value}`),
})))
const workflowEdgeOperatorHelp = computed(() => t(`workflow.edgeEditor.operatorHelp.${edgeEditorConditionOperator.value}`))
const workflowConditionValueTypeValues: WorkflowConditionValueType[] = ['string', 'number', 'boolean', 'null', 'array', 'object']
const workflowConditionValueTypeOptions = computed(() => workflowConditionValueTypeValues.map(value => ({
  value,
  label: t(`workflow.edgeEditor.valueTypes.${value}`),
})))
const requiredConditionValueType = computed(() => requiredWorkflowConditionValueType(edgeEditorConditionOperator.value))
const workflowConditionValueTypeDisabled = computed(() => requiredConditionValueType.value !== null)
const workflowConditionValuePlaceholder = computed(() => t(`workflow.edgeEditor.conditionValuePlaceholders.${edgeEditorConditionValueType.value}`))
const workflowConditionValueError = computed(() => {
  if (edgeEditorConditionPathPreset.value === 'route-only' || !workflowConditionNeedsValue(edgeEditorConditionOperator.value)) return ''
  try {
    parseWorkflowConditionValue(
      edgeEditorConditionValue.value,
      edgeEditorConditionOperator.value,
      edgeEditorConditionValueType.value,
    )
    return ''
  } catch {
    return t(`workflow.edgeEditor.invalidValueTypes.${edgeEditorConditionValueType.value}`)
  }
})
const workflowConditionPathOptions = computed(() => {
  const options = [{ label: t('workflow.edgeEditor.conditionPathOptions.routeOnly'), value: 'route-only' }]
  if (edgeEditorRoute.value !== 'failure') {
    options.push({
      label: t(edgeEditorRoute.value === 'success'
        ? 'workflow.edgeEditor.conditionPathOptions.outputRecommended'
        : 'workflow.edgeEditor.conditionPathOptions.output'),
      value: 'output',
    })
  }
  if (edgeEditorRoute.value !== 'success') {
    options.push({
      label: t(edgeEditorRoute.value === 'failure'
        ? 'workflow.edgeEditor.conditionPathOptions.errorRecommended'
        : 'workflow.edgeEditor.conditionPathOptions.error'),
      value: 'error',
    })
  }
  options.push({ label: t('workflow.edgeEditor.conditionPathOptions.custom'), value: 'custom' })
  return options
})
const automaticLoopId = computed(() => `loop:${edgeEditorId.value || 'edge'}`)
const workflowLoopIdOptions = computed(() => [
  { label: t('workflow.edgeEditor.loopIdAutomatic', { id: automaticLoopId.value }), value: LOOP_ID_AUTOMATIC },
  ...(edgeEditorLoopId.value ? [{ label: edgeEditorLoopId.value, value: edgeEditorLoopId.value }] : []),
])
const edgeEditorLoopIdSelection = computed({
  get: () => edgeEditorLoopId.value || LOOP_ID_AUTOMATIC,
  set: (value: string) => { edgeEditorLoopId.value = value === LOOP_ID_AUTOMATIC ? '' : value },
})
const connectionStartNodeId = ref<string | null>(null)
const lastCanvasTransaction = ref<CanvasTransaction<WorkflowNode, WorkflowEdge> | null>(null)
const workflowRunContextMenuVisible = ref(false)
const workflowRunContextMenuX = ref(0)
const workflowRunContextMenuY = ref(0)
const workflowRunContextMenuTarget = ref<WorkflowRunRecord | null>(null)
const workflowName = ref(t('workflow.title'))
const workflowWorkspace = ref<string | null>(null)
const workspaceModalVisible = ref(false)
const workspacePickerTarget = ref<'active' | 'create'>('active')
const activeWorkflowId = ref('')
const showWorkflowSidebar = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
const isMobile = ref(false)
const workflowsLoading = ref(false)
const workflowProfileFilter = ref<string | null>(null)
const createWorkflowDrawerVisible = ref(false)
const createWorkflowName = ref('')
const createWorkflowProfile = ref('default')
const createWorkflowWorkspace = ref<string | null>(null)
const creatingWorkflow = ref(false)
const isWorkflowBatchMode = ref(false)
const selectedWorkflowIds = ref<Set<string>>(new Set())
const deletingWorkflowIds = ref<Set<string>>(new Set())
const showWorkflowBatchDeleteConfirm = ref(false)
const isWorkflowBatchDeleting = ref(false)
const savingWorkflow = ref(false)
const executingWorkflow = ref(false)
const workflowRuns = ref<WorkflowRunRecord[]>([])
const workflowRunsLoading = ref(false)
const rerunningWorkflowNodeId = ref<string | null>(null)
const showWorkflowRunsPanel = ref(true)
const selectedWorkflowRunId = ref<string | null>(null)
const workflowEvidenceExpanded = ref(false)
const manuallyDeselectedWorkflowRunIds = ref<Set<string>>(new Set())
const autoSelectRunningWorkflowIds = ref<Set<string>>(new Set())
const workflowChatPanelVisible = ref(false)
const workflowChatPanelLoading = ref(false)
const workflowChatPanelTitle = ref('')
const workflowChatPanelNodeId = ref<string | null>(null)
const workflowChatPanelSessionId = ref<string | null>(null)
const workflowChatPanelExecutionId = ref<string | null>(null)
const workflowApprovalSubmitting = ref(false)
const workflowChatPanelWidth = ref(loadWorkflowChatPanelWidth())
const workflowChatResizeStart = ref<{ x: number; width: number } | null>(null)
const skillOptionsByKey = ref<Record<string, WorkflowSelectOption[]>>({})
const skillOptionsLoadingByKey = ref<Record<string, boolean>>({})
const skillOptionRequests = new Map<string, Promise<void>>()
const runtimeStatusByWorkflowId = ref<Record<string, WorkflowRuntimeStatus>>({})
let removeWorkflowStatusListener: (() => void) | null = null
let removeWorkflowStatusErrorListener: (() => void) | null = null
let mobileQuery: MediaQueryList | null = null
let applyingWorkflow = false
let workflowRunsLoadSeq = 0
let workflowRunsLoadingSeq = 0

const agentOptions = computed<WorkflowSelectOption[]>(() => [
  { label: 'Hermes', value: 'hermes' },
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
])

const modelGroups = computed<AvailableModelGroup[]>(() => appStore.modelGroups)

const defaultWorkflowProfile = computed(() =>
  profilesStore.activeProfileName || profilesStore.profiles[0]?.name || 'default',
)

const workflowProfileOptions = computed(() => {
  const profiles = profilesStore.profiles.length > 0
    ? profilesStore.profiles.map(profile => ({ label: profile.name, value: profile.name }))
    : [{ label: 'default', value: 'default' }]
  return profiles
})

const workflowProfileFilterOptions = computed(() => [
  { label: t('chat.allProfiles'), value: '__all__' },
  ...workflowProfileOptions.value,
])

function profileAvatarFor(profileName: string) {
  return profilesStore.profiles.find(profile => profile.name === profileName)?.avatar || null
}

const activeWorkflowProfile = computed(() => (
  workflows.value.find(workflow => workflow.id === activeWorkflowId.value)?.profile || defaultWorkflowProfile.value
))

const workspacePickerValue = computed({
  get: () => workspacePickerTarget.value === 'create' ? createWorkflowWorkspace.value : workflowWorkspace.value,
  set: (value: string | null) => {
    if (workspacePickerTarget.value === 'create') createWorkflowWorkspace.value = value
    else workflowWorkspace.value = value
  },
})

const workflowChatPanelStyle = computed(() => ({
  width: isMobile.value ? '100%' : `${workflowChatPanelWidth.value}px`,
}))

const defaultModelSelection = computed(() => {
  const selectedGroup = appStore.selectedProvider
    ? modelGroups.value.find(group => group.provider === appStore.selectedProvider)
    : undefined
  if (selectedGroup?.models.includes(appStore.selectedModel)) {
    return { provider: appStore.selectedProvider, model: appStore.selectedModel }
  }
  const fallbackGroup = modelGroups.value.find(group => group.models.length > 0)
  return {
    provider: fallbackGroup?.provider || '',
    model: fallbackGroup?.models[0] || '',
  }
})

const contextMenuOptions = computed<DropdownOption[]>(() => {
  const target = contextMenuTarget.value
  if (selectedWorkflowRunId.value) {
    if (target?.type !== 'node') return []
    const run = selectedWorkflowRun.value
    const isBusy = Boolean(rerunningWorkflowNodeId.value) || isWorkflowLive(activeWorkflowId.value)
    const hasNodeSession = Boolean(run?.node_sessions?.some(session => session.node_id === target.id && session.session_id))
    const hasRunnableNodeSession = Boolean(run?.node_sessions?.some(session => (
      session.node_id === target.id &&
      session.session_id &&
      session.status !== 'queued'
    )))
    const canPreserveStartNode = Boolean(run && workflowNodeStatusFromRun(run, target.id) === 'completed')
    const hasDownstream = edges.value.some(edge => edge.source === target.id)
    const options: DropdownOption[] = []
    if (hasNodeSession) {
      options.push({
        key: 'rerun-downstream-keep-node',
        label: t('workflow.actions.rerunDownstreamKeepNode'),
        disabled: isBusy || !hasDownstream || !canPreserveStartNode,
      })
    }
    options.push({
      key: 'rerun-from-node-clear',
      label: t('workflow.actions.rerunDownstreamClearNode'),
      disabled: isBusy || !hasRunnableNodeSession,
    })
    return options
  }
  if (target?.type === 'edge') {
    return [
      { key: 'edit-edge', label: t('workflow.actions.editEdge') },
      { key: 'delete-edge', label: t('workflow.actions.deleteEdge') },
    ]
  }
  return [{ key: 'delete-node', label: t('workflow.actions.deleteNode') }]
})

const workflowRunContextMenuOptions = computed<DropdownOption[]>(() => {
  const run = workflowRunContextMenuTarget.value
  const options: DropdownOption[] = []
  if (run?.status === 'queued' || run?.status === 'running') {
    options.push({ key: 'stop-run', label: t('workflow.runs.stop') })
  }
  options.push({ key: 'delete-run', label: t('workflow.runs.delete') })
  return options
})

const workflowFlowKey = computed(() => activeWorkflowId.value || 'workflow-empty')

function skillOptionsCacheKey(agent: string, profile = activeWorkflowProfile.value): string {
  const target = workflowAgentToSkillTarget(agent)
  return target === 'hermes' ? `${target}:${profile || 'default'}` : target
}

function skillOptionsForAgent(agent: string, profile = activeWorkflowProfile.value): WorkflowSelectOption[] {
  return skillOptionsByKey.value[skillOptionsCacheKey(agent, profile)] || []
}

function skillsLoadingForAgent(agent: string, profile = activeWorkflowProfile.value): boolean {
  return Boolean(skillOptionsLoadingByKey.value[skillOptionsCacheKey(agent, profile)])
}

function withRuntimeNodeData(data: WorkflowAgentNodeData): WorkflowAgentNodeData {
  return {
    ...data,
    agentOptions: agentOptions.value,
    skillOptions: skillOptionsForAgent(data.agent),
    skillsLoading: skillsLoadingForAgent(data.agent),
    modelGroups: modelGroups.value,
    onUpdate: updateNodeData,
    onUploadImages: uploadNodeImages,
  }
}

function refreshWorkflowNodeSkillOptions() {
  nodes.value = nodes.value.map<WorkflowNode>(node => ({
    ...node,
    data: withRuntimeNodeData(node.data),
  }))
}

async function ensureSkillOptionsForAgent(agent: string, profile = activeWorkflowProfile.value): Promise<void> {
  const target = workflowAgentToSkillTarget(agent)
  const key = skillOptionsCacheKey(agent, profile)
  if (skillOptionsByKey.value[key] || skillOptionRequests.has(key)) return skillOptionRequests.get(key)

  skillOptionsLoadingByKey.value = { ...skillOptionsLoadingByKey.value, [key]: true }
  refreshWorkflowNodeSkillOptions()

  const request = fetchSkills(target === 'hermes' ? profile : undefined, target)
    .then((data) => {
      skillOptionsByKey.value = {
        ...skillOptionsByKey.value,
        [key]: buildWorkflowSkillOptions(data),
      }
    })
    .catch((err) => {
      console.error('Failed to load workflow skills:', err)
      skillOptionsByKey.value = { ...skillOptionsByKey.value, [key]: [] }
    })
    .finally(() => {
      const { [key]: _finished, ...rest } = skillOptionsLoadingByKey.value
      skillOptionsLoadingByKey.value = rest
      skillOptionRequests.delete(key)
      refreshWorkflowNodeSkillOptions()
    })

  skillOptionRequests.set(key, request)
  return request
}

function ensureSkillOptionsForVisibleNodes() {
  const agents = new Set(nodes.value.map(node => node.data.agent))
  for (const agent of agents) void ensureSkillOptionsForAgent(agent)
}

function makeNode(
  id: string,
  title: string,
  position: { x: number; y: number },
  data: Partial<WorkflowAgentNodeEditableData> & { status?: WorkflowNodeStatus } = {},
): WorkflowNode {
  return {
    id,
    type: 'agent',
    position,
    dragHandle: '.node-header',
    style: { width: `${WORKFLOW_NODE_DEFAULT_WIDTH}px`, height: `${WORKFLOW_NODE_DEFAULT_HEIGHT}px` },
    data: {
      title,
      agent: data.agent || agentOptions.value[0]?.value || 'hermes',
      provider: data.provider || defaultModelSelection.value.provider,
      model: data.model || defaultModelSelection.value.model,
      apiMode: data.apiMode || defaultApiMode(data.provider || defaultModelSelection.value.provider),
      reasoningEffort: data.reasoningEffort || 'default',
      input: data.input || '',
      skills: data.skills || [],
      images: data.images || [],
      approvalRequired: data.approvalRequired === true,
      orchestration: { join: data.orchestration?.join === 'any' ? 'any' : 'all' },
      status: data.status || 'idle',
      agentOptions: agentOptions.value,
      skillOptions: skillOptionsForAgent(data.agent || agentOptions.value[0]?.value || 'hermes'),
      skillsLoading: skillsLoadingForAgent(data.agent || agentOptions.value[0]?.value || 'hermes'),
      modelGroups: modelGroups.value,
      onUpdate: updateNodeData,
      onUploadImages: uploadNodeImages,
    },
  }
}

function makeInitialNodes(): WorkflowNode[] {
  return []
}

const nodes = ref<WorkflowNode[]>(makeInitialNodes())
const edges = ref<WorkflowEdge[]>([])

const workflows = ref<WorkflowDocument[]>([])

const workflowList = computed(() => {
  const filtered = workflowProfileFilter.value
    ? workflows.value.filter(workflow => workflow.profile === workflowProfileFilter.value)
    : workflows.value
  return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
})

const canSelectAllWorkflows = computed(() => workflowList.value.length > 0)
const selectedWorkflowCount = computed(() => selectedWorkflowIds.value.size)
const selectedWorkflowRun = computed(() =>
  selectedWorkflowRunId.value
    ? workflowRuns.value.find(run => run.id === selectedWorkflowRunId.value) || null
    : null,
)
const selectedWorkflowEvidenceRows = computed(() => selectedWorkflowRun.value ? buildWorkflowEvidenceRows(selectedWorkflowRun.value) : [])

watch(selectedWorkflowRunId, () => {
  workflowEvidenceExpanded.value = false
})

const workflowChatPanelPendingApproval = computed(() => {
  const run = selectedWorkflowRun.value
  const nodeId = workflowChatPanelNodeId.value
  if (!run || !nodeId) return false
  return workflowNodeStatusFromRun(run, nodeId) === 'pending_approval'
})

watch([agentOptions, modelGroups], () => {
  nodes.value = nodes.value.map<WorkflowNode>(node => ({
    ...node,
    data: {
      ...node.data,
      ...normalizeNodeModel(node.data),
    },
  }))
  refreshWorkflowNodeSkillOptions()
})

watch([workflowName, workflowWorkspace, nodes, edges, nextNodeIndex], () => {
  syncActiveWorkflow()
}, { deep: true })

onMounted(() => {
  if (typeof window === 'undefined') return
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
  window.addEventListener('resize', handleWorkflowChatPanelViewportResize)
  window.addEventListener('keydown', handleWorkflowUndoShortcut)
  handleWorkflowChatPanelViewportResize()
  void initializeWorkflowPage()
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
  window.removeEventListener('resize', handleWorkflowChatPanelViewportResize)
  window.removeEventListener('keydown', handleWorkflowUndoShortcut)
  stopWorkflowChatResize()
  removeWorkflowStatusListener?.()
  removeWorkflowStatusListener = null
  removeWorkflowStatusErrorListener?.()
  removeWorkflowStatusErrorListener = null
  disconnectWorkflowSocket()
})

function handleMobileChange(event: MediaQueryList | MediaQueryListEvent) {
  isMobile.value = event.matches
  showWorkflowSidebar.value = !event.matches
  if (event.matches) showWorkflowRunsPanel.value = false
}

function openPageSidebar() {
  showWorkflowSidebar.value = true
}

function loadWorkflowChatPanelWidth() {
  if (typeof window === 'undefined') return WORKFLOW_CHAT_PANEL_DEFAULT_WIDTH
  const saved = Number.parseInt(window.localStorage.getItem(WORKFLOW_CHAT_PANEL_STORAGE_KEY) || '', 10)
  return Number.isFinite(saved) ? Math.round(saved) : WORKFLOW_CHAT_PANEL_DEFAULT_WIDTH
}

function workflowChatPanelMaxWidth() {
  if (typeof window === 'undefined') return 1180
  if (isMobile.value) return window.innerWidth
  const bodyWidth = workflowBodyRef.value?.clientWidth || window.innerWidth
  const reservedRunsWidth = showWorkflowRunsPanel.value ? WORKFLOW_RUNS_PANEL_WIDTH : 0
  const maxWidth = bodyWidth - reservedRunsWidth - WORKFLOW_CANVAS_MIN_WIDTH
  return Math.max(WORKFLOW_CHAT_PANEL_MIN_WIDTH, Math.min(Math.floor(bodyWidth * 0.72), maxWidth))
}

function clampWorkflowChatPanelWidth(width: number) {
  const maxWidth = workflowChatPanelMaxWidth()
  const minWidth = Math.min(WORKFLOW_CHAT_PANEL_MIN_WIDTH, maxWidth)
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)))
}

function handleWorkflowChatPanelViewportResize() {
  if (isMobile.value) return
  workflowChatPanelWidth.value = clampWorkflowChatPanelWidth(workflowChatPanelWidth.value)
}

function handleWorkflowChatResizeMove(event: PointerEvent) {
  const start = workflowChatResizeStart.value
  if (!start) return
  const delta = event.clientX - start.x
  workflowChatPanelWidth.value = clampWorkflowChatPanelWidth(start.width + delta)
}

function stopWorkflowChatResize() {
  if (!workflowChatResizeStart.value) return
  workflowChatResizeStart.value = null
  window.removeEventListener('pointermove', handleWorkflowChatResizeMove)
  window.removeEventListener('pointerup', stopWorkflowChatResize)
  if (!isMobile.value) {
    window.localStorage.setItem(WORKFLOW_CHAT_PANEL_STORAGE_KEY, String(workflowChatPanelWidth.value))
  }
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
}

function startWorkflowChatResize(event: PointerEvent) {
  if (isMobile.value) return
  event.preventDefault()
  workflowChatResizeStart.value = {
    x: event.clientX,
    width: workflowChatPanelWidth.value,
  }
  window.addEventListener('pointermove', handleWorkflowChatResizeMove)
  window.addEventListener('pointerup', stopWorkflowChatResize)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}

function closeWorkflowChatPanel() {
  workflowChatPanelVisible.value = false
  workflowChatPanelNodeId.value = null
  workflowChatPanelSessionId.value = null
  workflowChatPanelExecutionId.value = null
  workflowChatPanelTitle.value = ''
}

function defaultApiMode(provider: string) {
  const group = modelGroups.value.find(item => item.provider === provider)
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(group?.provider || provider, group?.base_url),
  )
}

function normalizeNodeModel(data: WorkflowAgentNodeData): Pick<WorkflowAgentNodeData, 'provider' | 'model' | 'apiMode'> {
  const currentGroup = modelGroups.value.find(group => group.provider === data.provider)
  if (currentGroup?.models.includes(data.model)) {
    return { provider: data.provider, model: data.model, apiMode: data.apiMode || defaultApiMode(data.provider) }
  }
  return {
    provider: defaultModelSelection.value.provider,
    model: defaultModelSelection.value.model,
    apiMode: defaultApiMode(defaultModelSelection.value.provider),
  }
}

function cloneWorkflowNodes(source: WorkflowNode[], options: { resetRuntime?: boolean } = {}): WorkflowNode[] {
  return source.map(node => ({
    ...node,
    position: { ...node.position },
    style: { ...node.style },
    data: withRuntimeNodeData({
      ...node.data,
      ...(options.resetRuntime ? { status: 'idle' as const, statusError: null, readonly: false } : {}),
    }),
  }))
}

function cloneWorkflowDefinitionNodes(source: WorkflowNode[]): WorkflowNode[] {
  return source.map(node => ({
    ...node,
    position: { ...node.position },
    style: { ...node.style },
    data: withRuntimeNodeData({
      ...node.data,
      status: 'idle',
      statusError: null,
      readonly: false,
    }),
  }))
}

function cloneWorkflowEdges(source: WorkflowEdge[]): WorkflowEdge[] {
  return source.map(edge => ({ ...edge }))
}

function serializeWorkflowNodes(source: WorkflowNode[]): unknown[] {
  return source.map(node => ({
    id: node.id,
    type: node.type,
    position: { ...node.position },
    dragHandle: node.dragHandle,
    style: { ...node.style },
    data: {
      title: node.data.title,
      agent: node.data.agent,
      provider: node.data.provider,
      model: node.data.model,
      apiMode: node.data.apiMode,
      reasoningEffort: node.data.reasoningEffort,
      input: node.data.input,
      skills: [...node.data.skills],
      images: [...node.data.images],
      approvalRequired: node.data.approvalRequired === true,
      orchestration: { join: node.data.orchestration?.join === 'any' ? 'any' : 'all' },
    },
  }))
}

function serializeWorkflowEdges(source: WorkflowEdge[]): unknown[] {
  return source.map(edge => ({ ...edge }))
}

function normalizeWorkflowViewport(raw: unknown): WorkflowViewport {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const x = Number(record.x)
  const y = Number(record.y)
  const zoom = Number(record.zoom)
  return {
    x: Number.isFinite(x) ? x : defaultViewport.x,
    y: Number.isFinite(y) ? y : defaultViewport.y,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : defaultViewport.zoom,
  }
}

function currentWorkflowViewport(): WorkflowViewport {
  return normalizeWorkflowViewport(getViewport())
}

function normalizeStoredNode(raw: unknown, index: number): WorkflowNode {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const data = record.data && typeof record.data === 'object' ? record.data as Partial<WorkflowAgentNodeData> : {}
  const rawPosition = record.position && typeof record.position === 'object' ? record.position as Record<string, unknown> : {}
  const rawX = Number(rawPosition.x)
  const rawY = Number(rawPosition.y)
  const position = {
    x: Number.isFinite(rawX) ? rawX : 80 + index * 320,
    y: Number.isFinite(rawY) ? rawY : 120,
  }
  const node = makeNode(
    typeof record.id === 'string' && record.id ? record.id : `agent-${index + 1}`,
    typeof data.title === 'string' && data.title ? data.title : t('workflow.newNodeTitle', { count: index + 1 }),
    position,
    {
      agent: data.agent,
      provider: data.provider,
      model: data.model,
      apiMode: data.apiMode,
      reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : 'default',
      input: data.input,
      skills: Array.isArray(data.skills) ? data.skills.filter(item => typeof item === 'string') : [],
      images: Array.isArray(data.images) ? data.images.filter(item => typeof item === 'string') : [],
      approvalRequired: data.approvalRequired === true,
      orchestration: { join: data.orchestration?.join === 'any' ? 'any' : 'all' },
      status: 'idle',
    },
  )
  return {
    ...node,
    dragHandle: typeof record.dragHandle === 'string' && record.dragHandle ? record.dragHandle : '.node-header',
    style: {
      width: typeof record.style?.width === 'string' ? record.style.width : node.style.width,
      height: typeof record.style?.height === 'string' ? record.style.height : node.style.height,
    },
  }
}

function normalizeStoredEdge(raw: unknown): WorkflowEdge | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  if (typeof record.source !== 'string' || typeof record.target !== 'string') return null
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `${record.source}-${record.target}`,
    source: record.source,
    target: record.target,
    sourceHandle: typeof record.sourceHandle === 'string' ? record.sourceHandle : 'output',
    targetHandle: typeof record.targetHandle === 'string' ? record.targetHandle : 'input',
    type: 'smoothstep',
    animated: Boolean(record.animated),
    markerEnd: MarkerType.ArrowClosed,
    data: record.data && typeof record.data === 'object' ? { ...record.data } : undefined,
  }
}

function nextIndexFromNodes(source: WorkflowNode[]): number {
  const max = source.reduce((result, node) => {
    const match = node.id.match(/^agent-(\d+)$/)
    return match ? Math.max(result, Number(match[1])) : result
  }, 0)
  return Math.max(max + 1, source.length + 1, 1)
}

function workflowDocumentFromRecord(record: WorkflowRecord): WorkflowDocument {
  const normalizedNodes = record.nodes.map(normalizeStoredNode)
  const normalizedEdges = record.edges.map(normalizeStoredEdge).filter((edge): edge is WorkflowEdge => Boolean(edge))
  return {
    id: record.id,
    name: record.name,
    profile: record.profile || 'default',
    workspace: record.workspace,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    viewport: normalizeWorkflowViewport(record.viewport),
    nextNodeIndex: nextIndexFromNodes(normalizedNodes),
    updatedAt: record.updated_at,
  }
}

async function initializeWorkflowPage() {
  await profilesStore.fetchProfiles()
  createWorkflowProfile.value = defaultWorkflowProfile.value
  removeWorkflowStatusListener = onWorkflowStatusUpdated(handleWorkflowRuntimeStatus)
  removeWorkflowStatusErrorListener = onWorkflowStatusError((error) => {
    console.error('Workflow execution evidence read failed:', error)
    message.error(error.error || t('workflow.evidence.loadFailed'))
  })
  await loadWorkflows()
  void subscribeWorkflowStatuses().then(applyWorkflowRuntimeStatuses).catch((err) => {
    console.error('Failed to subscribe workflow statuses:', err)
    message.error(err?.message || t('workflow.evidence.loadFailed'))
  })
}

async function loadWorkflows() {
  workflowsLoading.value = true
  try {
    let records: WorkflowRecord[]
    try {
      records = await listWorkflowsApi()
    } catch (httpErr) {
      console.warn('Failed to load workflows from HTTP, falling back to socket:', httpErr)
      records = await listWorkflowsSocket()
    }
    const docs = records.map(workflowDocumentFromRecord)
    const previousActiveId = activeWorkflowId.value
    workflows.value = docs
    if (docs.length === 0) {
      await clearActiveWorkflowPage()
      return
    }
    const activeWorkflow = previousActiveId
      ? docs.find(workflow => workflow.id === previousActiveId)
      : null
    if (previousActiveId && !activeWorkflow) {
      await clearActiveWorkflowPage()
      return
    }
    await applyWorkflow(activeWorkflow || docs[0], false)
  } catch (err) {
    console.error('Failed to load workflows:', err)
  } finally {
    workflowsLoading.value = false
  }
}

function applyWorkflowRuntimeStatuses(statuses: WorkflowRuntimeStatus[]) {
  const next = { ...runtimeStatusByWorkflowId.value }
  for (const status of statuses) next[status.workflowId] = status
  runtimeStatusByWorkflowId.value = next
}

function workflowNodeStatusFromRuntime(status?: WorkflowRuntimeStatus, nodeId?: string): WorkflowNodeStatus {
  const nodeStatus = nodeId ? status?.nodeStatuses?.[nodeId] : undefined
  const currentStatus = nodeId ? nodeStatus : status?.status
  switch (currentStatus) {
    case 'queued':
    case 'running':
    case 'pending_approval':
    case 'completed':
    case 'skipped':
    case 'failed':
    case 'approval_rejected':
    case 'canceled':
      return currentStatus
    default:
      return 'idle'
  }
}

function workflowNodeErrorFromRuntime(status?: WorkflowRuntimeStatus, nodeId?: string): string | null {
  if (!status || status.status !== 'failed') return null
  const nodeStatus = nodeId ? status.nodeStatuses?.[nodeId] : undefined
  return nodeStatus === 'failed' ? status.error || null : null
}

function isWorkflowLive(workflowId: string): boolean {
  const status = runtimeStatusByWorkflowId.value[workflowId]?.status
  return status === 'running' || status === 'queued'
}

function workflowCanvasRuntimeStatus(workflowId: string): WorkflowRuntimeStatus | undefined {
  const status = runtimeStatusByWorkflowId.value[workflowId]
  if (!status?.runId) return undefined
  if (status.runId !== selectedWorkflowRunId.value) return undefined
  return status.status === 'running' || status.status === 'queued' ? status : undefined
}

function workflowRunStatusClass(status: string): string {
  return `status-${status || 'idle'}`
}

function workflowRunStatusLabel(status: string): string {
  const key = status || 'idle'
  return t(`workflow.status.${key}`)
}

function workflowEvidenceTitle(row: WorkflowEvidenceRow): string {
  if (row.kind === 'edge') {
    return t('workflow.evidence.pathTitle', { source: row.sourceTitle || row.technicalId, target: row.targetTitle || row.technicalId })
  }
  if (row.kind === 'loop') return t('workflow.evidence.loopPass', { count: (row.iteration ?? 0) + 1 })
  return row.nodeTitle || row.technicalId
}

function workflowEvidenceStatusLabel(row: WorkflowEvidenceRow): string {
  if (row.kind === 'edge') {
    if (row.status === 'taken') return t('workflow.evidence.statuses.taken')
    if (row.status === 'not_taken') return t('workflow.evidence.statuses.notTaken')
    return t('workflow.evidence.statuses.evaluationFailed')
  }
  if (row.status === 'timed_out') return t('workflow.evidence.statuses.timedOut')
  if (row.status === 'blocked') return t('workflow.evidence.statuses.blocked')
  return workflowRunStatusLabel(row.status)
}

function workflowEvidenceDescription(row: WorkflowEvidenceRow): string {
  if (row.kind === 'edge') {
    if (row.status === 'taken') {
      const route = row.route === 'failure' ? 'failure' : row.route === 'always' ? 'always' : 'success'
      return t(`workflow.evidence.routes.${route}`)
    }
    if (row.status === 'error') return t('workflow.evidence.reasons.evaluationFailed')
    const reason = row.reason === 'condition_not_matched'
      ? 'conditionNotMatched'
      : row.reason === 'iteration_limit_reached'
        ? 'iterationLimitReached'
        : 'routeNotMatched'
    return t(`workflow.evidence.reasons.${reason}`)
  }
  if (row.kind === 'loop') {
    const exit = row.exitReason === 'feedback_taken'
      ? 'continued'
      : row.exitReason === 'iteration_limit_reached'
        ? 'iterationLimitReached'
        : row.exitReason === 'condition_not_matched'
          ? 'conditionNotMatched'
          : row.exitReason === 'route_not_matched' || row.exitReason === 'feedback_not_taken'
            ? 'finished'
            : null
    return exit ? t(`workflow.evidence.loopOutcomes.${exit}`) : row.exitReason || workflowEvidenceStatusLabel(row)
  }
  return row.error || t('workflow.evidence.exceptionalNode')
}

function formatWorkflowRunTime(timestamp: number | null): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

function formatWorkflowRunDuration(run: WorkflowRunRecord): string {
  if (!run.started_at) return '-'
  const end = run.finished_at || Date.now()
  const seconds = Math.max(0, Math.round((end - run.started_at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  if (minutes < 60) return remain ? `${minutes}m ${remain}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const minuteRemain = minutes % 60
  return minuteRemain ? `${hours}h ${minuteRemain}m` : `${hours}h`
}

function workflowRunNodeCount(run: WorkflowRunRecord): number {
  return Array.isArray(run.snapshot_nodes) ? run.snapshot_nodes.length : 0
}

function workflowNodeStatusFromRun(run: WorkflowRunRecord, nodeId: string): WorkflowNodeStatus {
  const runtimeStatus = runtimeStatusByWorkflowId.value[run.workflow_id]
  if (runtimeStatus?.runId === run.id) return workflowNodeStatusFromRuntime(runtimeStatus, nodeId)

  const nodeSession = latestWorkflowNodeSession(run.node_sessions, nodeId)
  switch (nodeSession?.status) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'approval_rejected':
    case 'canceled':
      return nodeSession.status
    case 'blocked':
      return 'failed'
    default:
      return run.status === 'running' || run.status === 'queued' ? 'queued' : 'idle'
  }
}

function workflowNodeErrorFromRun(run: WorkflowRunRecord, nodeId: string): string | null {
  const runtimeStatus = runtimeStatusByWorkflowId.value[run.workflow_id]
  if (runtimeStatus?.runId === run.id) return workflowNodeErrorFromRuntime(runtimeStatus, nodeId)
  const nodeSession = latestWorkflowNodeSession(run.node_sessions, nodeId)
  if (nodeSession?.status === 'failed' || nodeSession?.status === 'blocked') return nodeSession.error || run.error || null
  return null
}

async function openWorkflowNodeSession(nodeId: string) {
  const run = selectedWorkflowRun.value
  if (!run) return
  const node = nodes.value.find(item => item.id === nodeId)
  const nodeSession = latestWorkflowNodeSession(run.node_sessions, nodeId)
  if (!nodeSession?.session_id) {
    message.warning(t('workflow.runs.noNodeSession'))
    return
  }

  workflowChatPanelTitle.value = t('workflow.runs.nodeSessionTitle', { node: node?.data.title || nodeId })
  workflowChatPanelNodeId.value = nodeId
  workflowChatPanelSessionId.value = nodeSession.session_id
  workflowChatPanelExecutionId.value = nodeSession.execution_id || nodeId
  workflowChatPanelVisible.value = true
  workflowChatPanelLoading.value = true
  try {
    const session = await fetchSession(nodeSession.session_id, nodeSession.profile || run.profile)
    if (!session) {
      message.error(t('workflow.runs.loadNodeSessionFailed'))
      return
    }
    chatStore.ensureSessionLoaded(session)
    await chatStore.switchSession(nodeSession.session_id)
  } catch (err) {
    console.error('Failed to load workflow node session:', err)
    message.error(t('workflow.runs.loadNodeSessionFailed'))
  } finally {
    workflowChatPanelLoading.value = false
  }
}

async function respondWorkflowNodeApproval(approved: boolean) {
  const workflowId = activeWorkflowId.value
  const runId = selectedWorkflowRunId.value
  const nodeId = workflowChatPanelNodeId.value
  if (!workflowId || !runId || !nodeId || workflowApprovalSubmitting.value) return
  workflowApprovalSubmitting.value = true
  try {
    await approveWorkflowNode(workflowId, runId, nodeId, approved, workflowChatPanelExecutionId.value || undefined)
  } catch (err: any) {
    message.error(err?.message || t('workflow.actions.executionFailed'))
  } finally {
    workflowApprovalSubmitting.value = false
  }
}

async function loadWorkflowRuns(
  workflowId = activeWorkflowId.value,
  selectRunId?: string | null,
  options: { silent?: boolean; applySelectedSnapshot?: boolean } = {},
) {
  if (!workflowId) {
    workflowRuns.value = []
    return
  }
  const requestSeq = ++workflowRunsLoadSeq
  if (!options.silent) {
    workflowRunsLoadingSeq = requestSeq
    workflowRunsLoading.value = true
  }
  try {
    const runs = await listWorkflowRuns(workflowId, 100)
    if (requestSeq !== workflowRunsLoadSeq) return
    const nextSelectedRunId = selectRunId || selectedWorkflowRunId.value
    if (nextSelectedRunId) {
      const selectedIndex = runs.findIndex(run => run.id === nextSelectedRunId)
      if (selectedIndex >= 0) runs[selectedIndex] = await fetchWorkflowRun(workflowId, nextSelectedRunId)
    }
    if (requestSeq !== workflowRunsLoadSeq) return
    workflowRuns.value = runs
    if (nextSelectedRunId) {
      const selectedRun = runs.find(run => run.id === nextSelectedRunId)
      if (selectedRun) {
        selectedWorkflowRunId.value = selectedRun.id
        if (options.applySelectedSnapshot !== false) {
          await applyWorkflowRunSnapshot(selectedRun)
        }
      } else if (selectedWorkflowRunId.value === nextSelectedRunId) {
        selectedWorkflowRunId.value = null
      }
    }
  } catch (err) {
    console.error('Failed to load workflow runs:', err)
  } finally {
    if (!options.silent && workflowRunsLoadingSeq === requestSeq) {
      workflowRunsLoading.value = false
    }
  }
}

async function applyWorkflowRunSnapshot(run: WorkflowRunRecord) {
  applyingWorkflow = true
  const workflow = workflows.value.find(item => item.id === run.workflow_id)
  const currentNodePositions = new Map((workflow?.nodes || []).map(node => [node.id, { ...node.position }]))
  nodes.value = run.snapshot_nodes.map((raw, index) => {
    const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    const rawPosition = record.position && typeof record.position === 'object' ? record.position as Record<string, unknown> : null
    const hasSnapshotPosition = rawPosition && Number.isFinite(rawPosition.x) && Number.isFinite(rawPosition.y)
    const fallbackPosition = typeof record.id === 'string' ? currentNodePositions.get(record.id) : undefined
    return normalizeStoredNode(
      !hasSnapshotPosition && fallbackPosition ? { ...record, position: fallbackPosition } : record,
      index,
    )
  }).map<WorkflowNode>(node => ({
    ...node,
    data: withRuntimeNodeData({
      ...node.data,
      status: workflowNodeStatusFromRun(run, node.id),
      statusError: workflowNodeErrorFromRun(run, node.id),
      readonly: true,
    }),
  }))
  edges.value = run.snapshot_edges.map(normalizeStoredEdge).filter((edge): edge is WorkflowEdge => Boolean(edge))
  nextNodeIndex.value = nextIndexFromNodes(nodes.value)
  await nextTick()
  applyingWorkflow = false
  ensureSkillOptionsForVisibleNodes()
}

async function clearSelectedWorkflowRun() {
  const runId = selectedWorkflowRunId.value
  if (runId) {
    manuallyDeselectedWorkflowRunIds.value = new Set([...manuallyDeselectedWorkflowRunIds.value, runId])
  }
  const nextAutoSelect = new Set(autoSelectRunningWorkflowIds.value)
  nextAutoSelect.delete(activeWorkflowId.value)
  autoSelectRunningWorkflowIds.value = nextAutoSelect
  selectedWorkflowRunId.value = null
  const workflow = workflows.value.find(item => item.id === activeWorkflowId.value)
  if (workflow) await applyWorkflow(workflow, false, { resetRuntime: true })
}

async function clearActiveWorkflowPage() {
  applyingWorkflow = true
  activeWorkflowId.value = ''
  workflowName.value = ''
  workflowWorkspace.value = null
  nodes.value = []
  edges.value = []
  nextNodeIndex.value = 1
  workflowRuns.value = []
  selectedWorkflowRunId.value = null
  manuallyDeselectedWorkflowRunIds.value = new Set()
  autoSelectRunningWorkflowIds.value = new Set()
  closeWorkflowChatPanel()
  closeContextMenu()
  closeWorkflowRunContextMenu()
  await nextTick()
  applyingWorkflow = false
}

async function selectWorkflowRun(run: WorkflowRunRecord) {
  if (selectedWorkflowRunId.value === run.id) {
    await clearSelectedWorkflowRun()
    return
  }
  const nextDeselected = new Set(manuallyDeselectedWorkflowRunIds.value)
  nextDeselected.delete(run.id)
  manuallyDeselectedWorkflowRunIds.value = nextDeselected
  selectedWorkflowRunId.value = run.id
  await applyWorkflowRunSnapshot(run)
}

function openWorkflowRunContextMenu(event: MouseEvent, run: WorkflowRunRecord) {
  event.preventDefault()
  event.stopPropagation()
  workflowRunContextMenuX.value = event.clientX
  workflowRunContextMenuY.value = event.clientY
  workflowRunContextMenuTarget.value = run
  workflowRunContextMenuVisible.value = false
  void nextTick(() => {
    workflowRunContextMenuVisible.value = true
  })
}

function closeWorkflowRunContextMenu() {
  workflowRunContextMenuVisible.value = false
  workflowRunContextMenuTarget.value = null
}

async function toggleWorkflowRunsPanel() {
  const nextVisible = !showWorkflowRunsPanel.value
  showWorkflowRunsPanel.value = nextVisible
  if (!nextVisible && selectedWorkflowRunId.value) {
    await clearSelectedWorkflowRun()
  }
}

async function handleWorkflowRunContextMenuSelect(key: string | number) {
  const run = workflowRunContextMenuTarget.value
  closeWorkflowRunContextMenu()
  if (!run || !activeWorkflowId.value) return
  if (key === 'stop-run') {
    try {
      const stopped = await stopWorkflowRun(activeWorkflowId.value, run.id)
      workflowRuns.value = workflowRuns.value.map(item => item.id === stopped.id ? { ...item, ...stopped } : item)
      await loadWorkflowRuns(activeWorkflowId.value, selectedWorkflowRunId.value)
      message.success(t('workflow.runs.stopRequested'))
    } catch (err: any) {
      message.error(err?.message || t('workflow.runs.stopFailed'))
    }
    return
  }
  if (key === 'delete-run') {
    try {
      await deleteWorkflowRun(activeWorkflowId.value, run.id)
      workflowRuns.value = workflowRuns.value.filter(item => item.id !== run.id)
      if (selectedWorkflowRunId.value === run.id) {
        await clearSelectedWorkflowRun()
      }
      message.success(t('workflow.runs.deleteSuccess'))
    } catch (err: any) {
      message.error(err?.message || t('common.deleteFailed'))
    }
  }
}

function handleWorkflowRuntimeStatus(status: WorkflowRuntimeStatus) {
  runtimeStatusByWorkflowId.value = {
    ...runtimeStatusByWorkflowId.value,
    [status.workflowId]: status,
  }
  if (status.workflowId !== activeWorkflowId.value) return
  if (status.run) {
    const existingIndex = workflowRuns.value.findIndex(run => run.id === status.run!.id)
    workflowRuns.value = existingIndex >= 0
      ? workflowRuns.value.map(run => run.id === status.run!.id ? status.run! : run)
      : [status.run, ...workflowRuns.value]
  }
  const isLive = status.status === 'running' || status.status === 'queued'
  if (!isLive) {
    const nextAutoSelect = new Set(autoSelectRunningWorkflowIds.value)
    nextAutoSelect.delete(status.workflowId)
    autoSelectRunningWorkflowIds.value = nextAutoSelect
  }
  if (status.runId) {
    const shouldAutoSelect = isLive &&
      autoSelectRunningWorkflowIds.value.has(status.workflowId) &&
      !manuallyDeselectedWorkflowRunIds.value.has(status.runId)
    if (shouldAutoSelect) {
      showWorkflowRunsPanel.value = true
      const wasSelected = selectedWorkflowRunId.value === status.runId
      selectedWorkflowRunId.value = status.runId
      void loadWorkflowRuns(status.workflowId, status.runId, {
        silent: true,
        applySelectedSnapshot: !wasSelected,
      })
    } else if (selectedWorkflowRunId.value === status.runId) {
      void loadWorkflowRuns(status.workflowId, status.runId, {
        silent: true,
        applySelectedSnapshot: false,
      })
    } else if (showWorkflowRunsPanel.value) {
      void loadWorkflowRuns(status.workflowId, null, {
        silent: true,
        applySelectedSnapshot: false,
      })
    }
  }
  if (!selectedWorkflowRunId.value || selectedWorkflowRunId.value !== status.runId) return
  nodes.value = nodes.value.map<WorkflowNode>(node => ({
    ...node,
    data: withRuntimeNodeData({
      ...node.data,
      status: workflowNodeStatusFromRuntime(status, node.id),
      statusError: workflowNodeErrorFromRuntime(status, node.id),
    }),
  }))
}

function handleWorkflowProfileFilterChange(value: string) {
  workflowProfileFilter.value = value === '__all__' ? null : value
  selectedWorkflowIds.value = new Set()
}

function toggleWorkflowBatchMode() {
  isWorkflowBatchMode.value = !isWorkflowBatchMode.value
  if (!isWorkflowBatchMode.value) {
    selectedWorkflowIds.value = new Set()
    showWorkflowBatchDeleteConfirm.value = false
  }
}

function toggleWorkflowSelection(workflowId: string) {
  const next = new Set(selectedWorkflowIds.value)
  if (next.has(workflowId)) next.delete(workflowId)
  else next.add(workflowId)
  selectedWorkflowIds.value = next
}

function isWorkflowSelected(workflowId: string): boolean {
  return selectedWorkflowIds.value.has(workflowId)
}

function selectAllWorkflows() {
  selectedWorkflowIds.value = new Set(workflowList.value.map(workflow => workflow.id))
}

async function handleWorkflowListItemClick(workflowId: string) {
  if (isWorkflowBatchMode.value) {
    toggleWorkflowSelection(workflowId)
    return
  }
  await selectWorkflow(workflowId)
}

async function handleWorkflowBatchDeleteConfirm() {
  if (selectedWorkflowIds.value.size === 0 || isWorkflowBatchDeleting.value) return
  const ids = [...selectedWorkflowIds.value]
  isWorkflowBatchDeleting.value = true
  try {
    const result = await batchDeleteWorkflows(ids)
    const deletedIds = new Set(ids.filter(id => !result.errors.some(error => error.id === id)))
    workflows.value = workflows.value.filter(workflow => !deletedIds.has(workflow.id))
    selectedWorkflowIds.value = new Set()
    showWorkflowBatchDeleteConfirm.value = false
    isWorkflowBatchMode.value = false
    if (deletedIds.has(activeWorkflowId.value)) {
      await clearActiveWorkflowPage()
    }
    if (result.deleted > 0) message.success(t('workflow.batch.deleteSuccess', { count: result.deleted }))
    if (result.failed > 0) message.warning(t('workflow.batch.deletePartial', { failed: result.failed }))
  } catch (err: any) {
    message.error(err?.message || t('workflow.batch.deleteFailed'))
  } finally {
    isWorkflowBatchDeleting.value = false
  }
}

async function handleWorkflowDelete(workflowId: string) {
  if (deletingWorkflowIds.value.has(workflowId)) return
  deletingWorkflowIds.value = new Set([...deletingWorkflowIds.value, workflowId])
  try {
    await deleteWorkflowApi(workflowId)
    workflows.value = workflows.value.filter(workflow => workflow.id !== workflowId)
    const nextSelected = new Set(selectedWorkflowIds.value)
    nextSelected.delete(workflowId)
    selectedWorkflowIds.value = nextSelected

    if (workflowId === activeWorkflowId.value) {
      await clearActiveWorkflowPage()
    }
    message.success(t('workflow.batch.deleteSuccess', { count: 1 }))
  } catch (err: any) {
    message.error(err?.message || t('workflow.batch.deleteFailed'))
  } finally {
    const nextDeleting = new Set(deletingWorkflowIds.value)
    nextDeleting.delete(workflowId)
    deletingWorkflowIds.value = nextDeleting
  }
}

function openWorkspacePicker(target: 'active' | 'create') {
  workspacePickerTarget.value = target
  workspaceModalVisible.value = true
}

function clearWorkspacePicker() {
  workspacePickerValue.value = null
}

function syncActiveWorkflow() {
  if (applyingWorkflow || selectedWorkflowRunId.value) return
  workflows.value = workflows.value.map(workflow => (
    workflow.id === activeWorkflowId.value
      ? {
          ...workflow,
          name: workflowName.value.trim() || t('workflow.title'),
          workspace: workflowWorkspace.value,
          nodes: cloneWorkflowDefinitionNodes(nodes.value),
          edges: cloneWorkflowEdges(edges.value),
          viewport: currentWorkflowViewport(),
          nextNodeIndex: nextNodeIndex.value,
          updatedAt: workflow.updatedAt,
        }
      : workflow
  ))
}

async function applyWorkflow(
  workflow: WorkflowDocument,
  closeMobile: boolean,
  options: { resetRuntime?: boolean } = {},
) {
  applyingWorkflow = true
  selectedWorkflowRunId.value = null
  activeWorkflowId.value = workflow.id
  workflowName.value = workflow.name
  workflowWorkspace.value = workflow.workspace
  const runtimeStatus = workflowCanvasRuntimeStatus(workflow.id)
  nodes.value = cloneWorkflowNodes(workflow.nodes, { resetRuntime: options.resetRuntime }).map<WorkflowNode>(node => ({
    ...node,
    data: withRuntimeNodeData({
      ...node.data,
      status: options.resetRuntime ? 'idle' : workflowNodeStatusFromRuntime(runtimeStatus, node.id),
      statusError: options.resetRuntime ? null : workflowNodeErrorFromRuntime(runtimeStatus, node.id),
      readonly: false,
    }),
  }))
  edges.value = cloneWorkflowEdges(workflow.edges)
  nextNodeIndex.value = workflow.nextNodeIndex
  await nextTick()
  await setViewport(workflow.viewport, { duration: 0 })
  applyingWorkflow = false
  ensureSkillOptionsForVisibleNodes()
  void loadWorkflowRuns(workflow.id)
  if (closeMobile && isMobile.value) showWorkflowSidebar.value = false
}

async function selectWorkflow(workflowId: string) {
  if (workflowId === activeWorkflowId.value) {
    if (isMobile.value) showWorkflowSidebar.value = false
    return
  }
  syncActiveWorkflow()
  const workflow = workflows.value.find(item => item.id === workflowId)
  if (!workflow) return
  const nextAutoSelect = new Set(autoSelectRunningWorkflowIds.value)
  nextAutoSelect.delete(workflowId)
  autoSelectRunningWorkflowIds.value = nextAutoSelect
  await applyWorkflow(workflow, true)
}

async function exportActiveWorkflow() {
  if (!activeWorkflowId.value) return
  try {
    if (!await saveActiveWorkflow({ quiet: true })) return
    const envelope = await exportWorkflow(activeWorkflowId.value)
    const blob = new Blob([`${JSON.stringify(envelope, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${workflowName.value.trim().replace(/[^\w.-]+/g, '-') || 'workflow'}.workflow.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    message.success(t('workflow.actions.exported'))
  } catch (err: any) { message.error(err?.message || t('workflow.actions.exportFailed')) }
}

function openWorkflowImport() {
  workflowImportInputRef.value?.click()
}

async function handleWorkflowImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const document = await file.text()
    const profile = workflowProfileFilter.value || defaultWorkflowProfile.value
    const preview = await previewWorkflowImport(document, profile)
    workflowImportProfile.value = profile
    workflowImportPreview.value = preview
    workflowImportConfirmVisible.value = true
  } catch (err: any) { message.error(err?.message || t('workflow.actions.importFailed')) }
}

async function dismissPendingWorkflowImport() {
  const preview = workflowImportPreview.value
  workflowImportConfirmVisible.value = false
  workflowImportPreview.value = null
  if (!preview) return
  try { await cancelWorkflowImport(preview.token, workflowImportProfile.value) }
  catch (err) { console.error('Failed to cancel workflow import preview:', err) }
}

async function confirmPendingWorkflowImport() {
  const preview = workflowImportPreview.value
  if (!preview || workflowImportConfirming.value) return
  workflowImportConfirming.value = true
  try {
    const record = await confirmWorkflowImport(preview.token, workflowImportProfile.value)
    const imported = workflowDocumentFromRecord(record)
    workflows.value = [imported, ...workflows.value.filter(item => item.id !== imported.id)]
    workflowImportConfirmVisible.value = false
    workflowImportPreview.value = null
    await applyWorkflow(imported, true)
    void subscribeWorkflowStatuses(imported.id).then(applyWorkflowRuntimeStatuses).catch((err) => {
      console.error('Failed to subscribe imported workflow status:', err)
    })
    message.success(t('workflow.actions.imported'))
  } catch (err: any) {
    workflowImportConfirmVisible.value = false
    workflowImportPreview.value = null
    message.error(err?.message || t('workflow.actions.importFailed'))
  } finally {
    workflowImportConfirming.value = false
  }
}

function openCreateWorkflowDrawer() {
  createWorkflowName.value = `${t('workflow.title')} ${workflows.value.length + 1}`
  createWorkflowProfile.value = defaultWorkflowProfile.value
  createWorkflowWorkspace.value = null
  createWorkflowDrawerVisible.value = true
  if (profilesStore.profiles.length === 0) void profilesStore.fetchProfiles()
}

async function submitCreateWorkflow() {
  const name = createWorkflowName.value.trim()
  if (!name) {
    message.warning(t('workflow.namePlaceholder'))
    return
  }
  creatingWorkflow.value = true
  try {
    const initialNodes = makeInitialNodes()
    const record = await createWorkflowApi({
      name,
      profile: createWorkflowProfile.value || defaultWorkflowProfile.value,
      workspace: createWorkflowWorkspace.value,
      nodes: serializeWorkflowNodes(initialNodes),
      edges: serializeWorkflowEdges([]),
      viewport: defaultViewport,
    })
    const workflow = workflowDocumentFromRecord(record)
    workflows.value = [workflow, ...workflows.value]
    createWorkflowDrawerVisible.value = false
    await applyWorkflow(workflow, true)
    void subscribeWorkflowStatuses(workflow.id).then(applyWorkflowRuntimeStatuses).catch((err) => {
      console.error('Failed to subscribe workflow status:', err)
    })
  } catch (err: any) {
    message.error(err?.message || t('common.saveFailed'))
  } finally {
    creatingWorkflow.value = false
  }
}

function workflowNodeLabel(node: WorkflowNode): string {
  return node.data.title.trim() || node.id
}

function hasWorkflowCycle(sourceNodes: WorkflowNode[], sourceEdges: WorkflowEdge[]): boolean {
  const nodeIds = new Set(sourceNodes.map(node => node.id))
  const adjacency = new Map<string, string[]>()
  for (const node of sourceNodes) adjacency.set(node.id, [])
  for (const edge of sourceEdges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.data?.orchestration?.feedback) continue
    adjacency.get(edge.source)?.push(edge.target)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const nextId of adjacency.get(nodeId) || []) {
      if (visit(nextId)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return sourceNodes.some(node => visit(node.id))
}

function isWorkflowConnected(sourceNodes: WorkflowNode[], sourceEdges: WorkflowEdge[]): boolean {
  if (sourceNodes.length <= 1) return true

  const nodeIds = new Set(sourceNodes.map(node => node.id))
  const adjacency = new Map<string, string[]>()
  for (const node of sourceNodes) adjacency.set(node.id, [])
  for (const edge of sourceEdges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    adjacency.get(edge.source)?.push(edge.target)
    adjacency.get(edge.target)?.push(edge.source)
  }

  const startId = sourceNodes[0]?.id
  if (!startId) return true
  const visited = new Set<string>()
  const stack = [startId]
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId || visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const nextId of adjacency.get(nodeId) || []) {
      if (!visited.has(nextId)) stack.push(nextId)
    }
  }
  return visited.size === sourceNodes.length
}

function isValidWorkflowConnection(connection: Connection): boolean {
  return Boolean(
    connection.source &&
    connection.target &&
    connection.source !== connection.target &&
    connection.sourceHandle === 'output' &&
    connection.targetHandle === 'input',
  )
}

function workflowValidationError(): string | null {
  if (nodes.value.length === 0) return t('workflow.validation.nodesRequired')

  for (const node of nodes.value) {
    const label = workflowNodeLabel(node)
    if (!node.data.title.trim()) return t('workflow.validation.nodeNameRequired', { node: node.id })
    if (!node.data.provider.trim()) return t('workflow.validation.providerRequired', { node: label })
    if (!node.data.model.trim()) return t('workflow.validation.modelRequired', { node: label })
    if (node.data.agent !== 'hermes' && !node.data.apiMode) {
      return t('workflow.validation.apiModeRequired', { node: label })
    }
    if (!node.data.input.trim()) return t('workflow.validation.inputRequired', { node: label })
  }

  const nodeIds = new Set(nodes.value.map(node => node.id))
  const invalidEdge = edges.value.find(edge => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
  if (invalidEdge) return t('workflow.validation.invalidEdge')
  const invalidDirectionEdge = edges.value.find(edge => edge.sourceHandle !== 'output' || edge.targetHandle !== 'input')
  if (invalidDirectionEdge) return t('workflow.validation.invalidConnectionDirection')

  if (nodes.value.length > 1) {
    const connectedNodeIds = new Set<string>()
    for (const edge of edges.value) {
      connectedNodeIds.add(edge.source)
      connectedNodeIds.add(edge.target)
    }
    const orphanNode = nodes.value.find(node => !connectedNodeIds.has(node.id))
    if (orphanNode) return t('workflow.validation.orphanNode', { node: workflowNodeLabel(orphanNode) })
    if (!isWorkflowConnected(nodes.value, edges.value)) return t('workflow.validation.disconnectedFlow')
  }

  if (hasWorkflowCycle(nodes.value, edges.value)) return t('workflow.validation.cycle')
  return null
}

async function saveActiveWorkflow(options: { quiet?: boolean } = {}): Promise<boolean> {
  if (!activeWorkflowId.value || savingWorkflow.value || selectedWorkflowRunId.value) return false
  const validationError = workflowValidationError()
  if (validationError) {
    message.warning(validationError)
    return false
  }
  savingWorkflow.value = true
  try {
    const previous = workflows.value.find(workflow => workflow.id === activeWorkflowId.value)
    const record = await updateWorkflowApi(activeWorkflowId.value, {
      name: workflowName.value.trim() || t('workflow.title'),
      workspace: workflowWorkspace.value,
      nodes: serializeWorkflowNodes(nodes.value),
      edges: serializeWorkflowEdges(edges.value),
      viewport: currentWorkflowViewport(),
    })
    const savedWorkflow = workflowDocumentFromRecord(record)
    workflows.value = workflows.value.map(workflow => (
      workflow.id === savedWorkflow.id
        ? { ...savedWorkflow, updatedAt: previous?.updatedAt ?? savedWorkflow.updatedAt }
        : workflow
    ))
    if (!options.quiet) message.success(t('common.saved'))
    return true
  } catch (err: any) {
    message.error(err?.message || t('common.saveFailed'))
    return false
  } finally {
    savingWorkflow.value = false
  }
}

async function startWorkflowExecution() {
  if (!activeWorkflowId.value || executingWorkflow.value || selectedWorkflowRunId.value) return
  const workflowId = activeWorkflowId.value
  const saved = await saveActiveWorkflow({ quiet: true })
  if (!saved) return
  showWorkflowRunsPanel.value = true
  manuallyDeselectedWorkflowRunIds.value = new Set()
  autoSelectRunningWorkflowIds.value = new Set([...autoSelectRunningWorkflowIds.value, workflowId])
  executingWorkflow.value = true
  try {
    await runWorkflowNow(workflowId)
    void loadWorkflowRuns(workflowId)
    const now = Date.now()
    handleWorkflowRuntimeStatus({
      workflowId,
      status: 'running',
      runId: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      nodeStatuses: initialRunNodeStatuses(nodes.value, edges.value),
    })
    message.info(t('workflow.actions.executionStarted'))
  } catch (err: any) {
    message.error(err?.message || t('workflow.actions.executionFailed'))
  } finally {
    executingWorkflow.value = false
  }
}

async function rerunWorkflowFromNode(nodeId: string, preserveStartNode: boolean) {
  const workflowId = activeWorkflowId.value
  const run = selectedWorkflowRun.value
  if (!workflowId || !run || rerunningWorkflowNodeId.value) return
  rerunningWorkflowNodeId.value = nodeId
  showWorkflowRunsPanel.value = true
  autoSelectRunningWorkflowIds.value = new Set([...autoSelectRunningWorkflowIds.value, workflowId])
  closeWorkflowChatPanel()
  try {
    await rerunWorkflowRunFromNode(workflowId, run.id, nodeId, {
      preserve_start_node: preserveStartNode,
    })
    void loadWorkflowRuns(workflowId, run.id, {
      silent: true,
      applySelectedSnapshot: false,
    })
    const now = Date.now()
    const nextStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(
      nodes.value.map(node => [node.id, node.data.status || 'idle']),
    )
    const queuedNodeIds = rerunWorkflowNodeIds(nodeId, preserveStartNode, run)
    for (const queuedNodeId of queuedNodeIds) nextStatuses[queuedNodeId] = 'queued'
    handleWorkflowRuntimeStatus({
      workflowId,
      status: 'running',
      runId: run.id,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      nodeStatuses: nextStatuses,
    })
    message.info(
      preserveStartNode
        ? t('workflow.actions.rerunDownstreamStarted')
        : t('workflow.actions.rerunFromNodeStarted'),
    )
  } catch (err: any) {
    message.error(err?.message || t('workflow.actions.rerunFailed'))
  } finally {
    rerunningWorkflowNodeId.value = null
  }
}

function downstreamWorkflowNodeIds(nodeId: string): Set<string> {
  const visited = new Set<string>()
  const stack = edges.value.filter(edge => edge.source === nodeId).map(edge => edge.target)
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next || visited.has(next)) continue
    visited.add(next)
    for (const edge of edges.value.filter(edge => edge.source === next)) stack.push(edge.target)
  }
  return visited
}

function rerunWorkflowNodeIds(nodeId: string, preserveStartNode: boolean, run: WorkflowRunRecord): Set<string> {
  const activeIds = preserveStartNode
    ? downstreamWorkflowNodeIds(nodeId)
    : new Set([nodeId, ...downstreamWorkflowNodeIds(nodeId)])
  let expanded = true
  while (expanded) {
    expanded = false
    for (const edge of edges.value) {
      if (!activeIds.has(edge.target) || activeIds.has(edge.source)) continue
      if (workflowNodeStatusFromRun(run, edge.source) === 'completed') continue
      activeIds.add(edge.source)
      expanded = true
    }
  }
  return activeIds
}

function initialRunNodeStatuses(sourceNodes: WorkflowNode[], sourceEdges: WorkflowEdge[]): Record<string, WorkflowRuntimeState> {
  const nodeIds = new Set(sourceNodes.map(node => node.id))
  const targetIds = new Set(sourceEdges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map(edge => edge.target))
  const startIds = sourceNodes.filter(node => !targetIds.has(node.id)).map(node => node.id)
  const startIdSet = new Set(startIds.length > 0 ? startIds : sourceNodes.map(node => node.id))
  return Object.fromEntries(sourceNodes.map(node => [
    node.id,
    startIdSet.has(node.id) ? 'running' : 'queued',
  ]))
}

function updateNodeData(id: string, patch: Partial<WorkflowAgentNodeEditableData>) {
  if (selectedWorkflowRunId.value) return
  nodes.value = nodes.value.map<WorkflowNode>(node => (
    node.id === id
      ? {
          ...node,
          style: patch.images ? expandNodeHeightForImages(node.style, patch.images.length) : node.style,
          data: withRuntimeNodeData({
            ...node.data,
            ...patch,
            skills: typeof patch.agent === 'string' && patch.agent !== node.data.agent ? [] : patch.skills ?? node.data.skills,
          }),
        }
      : node
  ))
  if (typeof patch.agent === 'string') void ensureSkillOptionsForAgent(patch.agent)
}

function expandNodeHeightForImages(style: WorkflowNode['style'], imageCount: number): WorkflowNode['style'] {
  if (imageCount <= 0) return style
  const currentHeight = Number.parseFloat(style.height || String(WORKFLOW_NODE_DEFAULT_HEIGHT))
  const previewRows = Math.min(2, Math.ceil(imageCount / 3))
  const requiredHeight = WORKFLOW_NODE_DEFAULT_HEIGHT + previewRows * 68
  if (currentHeight >= requiredHeight) return style
  return { ...style, height: `${requiredHeight}px` }
}

function handleConnect(connection: Connection) {
  if (selectedWorkflowRunId.value) return
  if (!isValidWorkflowConnection(connection)) return
  const exists = edges.value.some(edge => edge.source === connection.source && edge.target === connection.target)
  if (exists) return

  edges.value = [...edges.value, {
    ...connection,
    id: `${connection.source}-${connection.target}`,
    type: 'smoothstep',
    animated: true,
    markerEnd: MarkerType.ArrowClosed,
  }]
}

function handleConnectStart(payload: { nodeId?: string; handleType?: string }) {
  connectionStartNodeId.value = payload.handleType === 'source' ? payload.nodeId || null : null
}

async function handleConnectEnd(event?: MouseEvent | TouchEvent) {
  const source = connectionStartNodeId.value
  connectionStartNodeId.value = null
  if (!source || !event || selectedWorkflowRunId.value || !activeWorkflowId.value) return
  const target = event.target as Element | null
  if (target?.closest('.vue-flow__handle, .vue-flow__node')) return
  const touch = 'changedTouches' in event ? event.changedTouches[0] : null
  const clientX = touch?.clientX ?? ('clientX' in event ? event.clientX : 0)
  const clientY = touch?.clientY ?? ('clientY' in event ? event.clientY : 0)
  const nodeId = `agent-${nextNodeIndex.value}`
  const position = screenToFlowCoordinate({ x: clientX, y: clientY })
  const node = makeNode(nodeId, t('workflow.newNodeTitle', { count: nextNodeIndex.value }), position)
  const transaction = createConnectedAgentTransaction<WorkflowNode, WorkflowEdge>(
    { nodes: nodes.value, edges: edges.value },
    { source, nodeId, title: node.data.title, position, nodeData: node.data },
  )
  transaction.after.edges[transaction.after.edges.length - 1] = {
    ...transaction.after.edges[transaction.after.edges.length - 1], animated: true, markerEnd: MarkerType.ArrowClosed,
  }
  setNodes(transaction.after.nodes)
  await nextTick()
  updateNodeInternals([nodeId])
  setEdges(transaction.after.edges)
  await nextTick()
  // Selection lives in Vue Flow's internal store, not in our definition
  // array. Apply it after the release gesture has committed Node + Edge.
  window.setTimeout(() => {
    removeSelectedElements()
    const createdNode = findNode(nodeId)
    if (createdNode) addSelectedNodes([createdNode])
  }, 0)
  lastCanvasTransaction.value = transaction
  nextNodeIndex.value += 1
  ensureSkillOptionsForVisibleNodes()
}

function undoLastCanvasTransaction() {
  const transaction = lastCanvasTransaction.value
  if (!transaction || selectedWorkflowRunId.value) return
  setNodes(transaction.before.nodes)
  setEdges(transaction.before.edges)
  nextNodeIndex.value = Math.max(1, nextNodeIndex.value - 1)
  lastCanvasTransaction.value = null
}

function handleWorkflowUndoShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]')) return
  if (!lastCanvasTransaction.value || selectedWorkflowRunId.value) return
  event.preventDefault()
  undoLastCanvasTransaction()
}

function deleteNode(nodeId: string) {
  nodes.value = nodes.value.filter(node => node.id !== nodeId)
  edges.value = edges.value.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
}

function deleteEdge(edgeId: string) {
  edges.value = edges.value.filter(edge => edge.id !== edgeId)
}

function openContextMenu(event: MouseEvent | TouchEvent, target: { type: 'node' | 'edge'; id: string }) {
  if (selectedWorkflowRunId.value && target.type !== 'node') return
  event.preventDefault()
  event.stopPropagation()
  const touch = 'changedTouches' in event ? event.changedTouches[0] : null
  contextMenuX.value = touch?.clientX ?? ('clientX' in event ? event.clientX : 0)
  contextMenuY.value = touch?.clientY ?? ('clientY' in event ? event.clientY : 0)
  contextMenuOpenedAt.value = Date.now()
  contextMenuTarget.value = target
  contextMenuVisible.value = false
  void nextTick(() => {
    contextMenuVisible.value = true
  })
}

function handleNodeContextMenu(payload: { event: MouseEvent | TouchEvent; node: { id: string } }) {
  openContextMenu(payload.event, { type: 'node', id: payload.node.id })
}

function handleNodeClick(payload: { node: { id: string } }) {
  if (!selectedWorkflowRunId.value) return
  void openWorkflowNodeSession(payload.node.id)
}

function setConditionPathPreset(preset: 'route-only' | 'output' | 'error' | 'custom') {
  edgeEditorConditionPathPreset.value = preset
  if (preset === 'route-only') edgeEditorConditionPath.value = ''
  if (preset === 'output' || preset === 'error') edgeEditorConditionPath.value = preset
}

function handleEdgeEditorRouteChange(route: 'success' | 'failure' | 'always') {
  edgeEditorRoute.value = route
  if (route === 'success' && edgeEditorConditionPathPreset.value === 'error') setConditionPathPreset('output')
  if (route === 'failure' && edgeEditorConditionPathPreset.value === 'output') setConditionPathPreset('error')
}

function handleEdgeEditorOperatorChange(operator: string) {
  edgeEditorConditionOperator.value = operator
  const requiredType = requiredWorkflowConditionValueType(operator)
  if (requiredType) edgeEditorConditionValueType.value = requiredType
}

function handleEdgeEditorValueTypeChange(type: WorkflowConditionValueType) {
  if (requiredConditionValueType.value) return
  edgeEditorConditionValueType.value = type
}

function openEdgeEditor(edgeId: string) {
  if (selectedWorkflowRunId.value) return
  const edge = edges.value.find(item => item.id === edgeId)
  if (!edge) return
  const orchestration = edge.data?.orchestration
  edgeEditorId.value = edgeId
  edgeEditorRoute.value = orchestration?.route || 'success'
  edgeEditorConditionPath.value = orchestration?.condition?.path || ''
  edgeEditorConditionPathPreset.value = !edgeEditorConditionPath.value
    ? 'route-only'
    : edgeEditorConditionPath.value === 'output' || edgeEditorConditionPath.value === 'error'
      ? edgeEditorConditionPath.value
      : 'custom'
  edgeEditorConditionOperator.value = orchestration?.condition?.operator || 'equals'
  const conditionValue = orchestration?.condition?.value
  edgeEditorConditionValueType.value = requiredWorkflowConditionValueType(edgeEditorConditionOperator.value)
    || inferWorkflowConditionValueType(conditionValue)
  edgeEditorConditionValue.value = serializeWorkflowConditionValueForType(conditionValue, edgeEditorConditionValueType.value)
  edgeEditorFeedback.value = Boolean(orchestration?.feedback)
  edgeEditorMaxIterations.value = String(orchestration?.feedback?.maxIterations || 3)
  edgeEditorLoopId.value = orchestration?.feedback?.loopId || ''
  edgeEditorVisible.value = true
}

function handleEdgeClick(payload: { edge: { id: string } }) {
  openEdgeEditor(payload.edge.id)
}

function saveEdgeEditor() {
  const maxIterations = Number(edgeEditorMaxIterations.value)
  if (edgeEditorFeedback.value && (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)) {
    message.error(t('workflow.edgeEditor.invalidIterations'))
    return
  }
  const conditionPath = edgeEditorConditionPath.value.trim()
  const loopId = edgeEditorLoopId.value.trim()
  if (edgeEditorFeedback.value && loopId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(loopId)) {
    message.error(t('workflow.edgeEditor.invalidLoopId'))
    return
  }
  const orchestration: WorkflowEdgeOrchestration = { route: edgeEditorRoute.value }
  if (conditionPath) {
    if (workflowConditionValueError.value) {
      message.error(workflowConditionValueError.value)
      return
    }
    try {
      const conditionValue = parseWorkflowConditionValue(
        edgeEditorConditionValue.value,
        edgeEditorConditionOperator.value,
        edgeEditorConditionValueType.value,
      )
      orchestration.condition = {
        path: conditionPath,
        operator: edgeEditorConditionOperator.value,
        ...(conditionValue !== undefined ? { value: conditionValue } : {}),
      }
    } catch (err: any) {
      message.error(err?.message || t('workflow.edgeEditor.invalidConditionValue'))
      return
    }
  }
  if (edgeEditorFeedback.value) orchestration.feedback = { maxIterations, ...(loopId ? { loopId } : {}) }
  edges.value = edges.value.map(edge => edge.id === edgeEditorId.value
    ? { ...edge, data: { ...(edge.data || {}), orchestration } }
    : edge)
  edgeEditorVisible.value = false
}

function handleEdgeContextMenu(payload: { event: MouseEvent | TouchEvent; edge: { id: string } }) {
  openContextMenu(payload.event, { type: 'edge', id: payload.edge.id })
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuTarget.value = null
}

function handleContextMenuClickOutside() {
  if (Date.now() - contextMenuOpenedAt.value < 180) return
  closeContextMenu()
}

function handleContextMenuSelect(key: string | number) {
  const target = contextMenuTarget.value
  if (key === 'rerun-downstream-keep-node' && target?.type === 'node') {
    void rerunWorkflowFromNode(target.id, true)
    closeContextMenu()
    return
  }
  if (key === 'rerun-from-node-clear' && target?.type === 'node') {
    void rerunWorkflowFromNode(target.id, false)
    closeContextMenu()
    return
  }
  if (selectedWorkflowRunId.value) {
    closeContextMenu()
    return
  }
  if (key === 'edit-edge' && target?.type === 'edge') {
    openEdgeEditor(target.id)
  }
  if (key === 'delete-node' && target?.type === 'node') {
    deleteNode(target.id)
  }
  if (key === 'delete-edge' && target?.type === 'edge') {
    deleteEdge(target.id)
  }
  closeContextMenu()
}

function getVisibleCanvasTopLeftPosition() {
  const rect = workflowCanvasRef.value?.getBoundingClientRect()
  if (!rect) return { x: 80, y: 120 }
  return screenToFlowCoordinate({
    x: rect.left + 48,
    y: rect.top + 48,
  })
}

function getNextVisibleNodePosition() {
  const start = getVisibleCanvasTopLeftPosition()
  const position = { ...start }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const overlaps = nodes.value.some(node =>
      Math.abs(node.position.x - position.x) < 300 &&
      Math.abs(node.position.y - position.y) < 180,
    )
    if (!overlaps) return position
    position.x = start.x + ((attempt + 1) % 3) * 320
    position.y = start.y + Math.floor((attempt + 1) / 3) * 220
  }

  return position
}

async function addAgentNode() {
  if (selectedWorkflowRunId.value) return
  if (!activeWorkflowId.value) {
    message.warning(t('workflow.actions.createWorkflowFirst'))
    return
  }
  const id = `agent-${nextNodeIndex.value}`
  nodes.value = [
    ...nodes.value,
    makeNode(id, t('workflow.newNodeTitle', { count: nextNodeIndex.value }), getNextVisibleNodePosition()),
  ]
  nextNodeIndex.value += 1
  ensureSkillOptionsForVisibleNodes()
  await nextTick()
}

async function uploadNodeImages(_nodeId: string, files: File[]) {
  const uploaded = await uploadRuntimeFiles(files)
  return uploaded.map(file => file.path)
}

function nodeColor(node: { data: WorkflowAgentNodeData }) {
  if (node.data.status === 'queued') return '#64748b'
  if (node.data.status === 'running') return '#2563eb'
  if (node.data.status === 'pending_approval') return '#d97706'
  if (node.data.status === 'completed') return '#16a34a'
  if (node.data.status === 'skipped') return '#64748b'
  if (node.data.status === 'failed') return '#dc2626'
  if (node.data.status === 'approval_rejected') return '#b45309'
  if (node.data.status === 'canceled') return '#f97316'
  return '#9ca3af'
}
</script>

<template>
  <div class="workflow-view">
    <div class="workflow-sidebar-backdrop" :class="{ active: showWorkflowSidebar }" @click="showWorkflowSidebar = false" />
    <aside class="workflow-sidebar" :class="{ collapsed: !showWorkflowSidebar }">
      <div v-if="showWorkflowSidebar" class="page-sidebar-top">
        <PageSidebarNav
          active="workflow"
          :primary-label="t('workflow.actions.newWorkflow')"
          @primary="openCreateWorkflowDrawer"
        />
        <div class="workflow-list-toolbar">
          <NSelect
            class="workflow-profile-filter"
            :value="workflowProfileFilter || '__all__'"
            :options="workflowProfileFilterOptions"
            size="small"
            :loading="profilesStore.loading"
            @update:value="handleWorkflowProfileFilterChange"
          />
          <div class="workflow-list-actions">
            <NButton
              v-if="!isWorkflowBatchMode"
              quaternary
              size="tiny"
              :title="t('workflow.batch.toggle')"
              @click="toggleWorkflowBatchMode"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NButton
              v-if="isWorkflowBatchMode"
              quaternary
              size="tiny"
              :disabled="!canSelectAllWorkflows || isWorkflowBatchDeleting"
              :title="t('workflow.batch.selectAll')"
              @click="selectAllWorkflows"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NPopconfirm
              v-if="isWorkflowBatchMode && selectedWorkflowCount > 0"
              v-model:show="showWorkflowBatchDeleteConfirm"
              :positive-button-props="{ loading: isWorkflowBatchDeleting, disabled: isWorkflowBatchDeleting }"
              :negative-button-props="{ disabled: isWorkflowBatchDeleting }"
              @positive-click="handleWorkflowBatchDeleteConfirm"
            >
              <template #trigger>
                <NButton quaternary size="tiny" type="error" :loading="isWorkflowBatchDeleting" :disabled="isWorkflowBatchDeleting">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('workflow.batch.confirmDelete', { count: selectedWorkflowCount }) }}
            </NPopconfirm>
            <NButton
              v-if="isWorkflowBatchMode"
              quaternary
              size="tiny"
              :disabled="isWorkflowBatchDeleting"
              @click="toggleWorkflowBatchMode"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </template>
            </NButton>
          </div>
        </div>
      </div>
      <div v-if="showWorkflowSidebar" class="workflow-list">
        <div v-if="workflowsLoading" class="workflow-list-empty">{{ t('common.loading') }}</div>
        <div v-else-if="workflowList.length === 0" class="workflow-list-empty">{{ t('common.noData') }}</div>
        <button
          v-for="workflow in workflowList"
          :key="workflow.id"
          class="workflow-list-item"
          :class="{ active: workflow.id === activeWorkflowId, selected: isWorkflowSelected(workflow.id) }"
          type="button"
          @click="handleWorkflowListItemClick(workflow.id)"
        >
          <span v-if="isWorkflowBatchMode" class="workflow-select-indicator">
            <NCheckbox
              :checked="isWorkflowSelected(workflow.id)"
              @click.stop="toggleWorkflowSelection(workflow.id)"
            />
          </span>
          <span class="workflow-list-avatar-wrap" :class="{ streaming: isWorkflowLive(workflow.id) }">
            <ProfileAvatar
              class="workflow-list-avatar"
              :name="workflow.profile"
              :avatar="profileAvatarFor(workflow.profile)"
              :size="28"
            />
          </span>
          <span class="workflow-list-main">
            <span class="workflow-list-name">{{ workflow.name }}</span>
            <span class="workflow-list-meta">{{ workflow.profile }} · {{ workflow.nodes.length }} {{ t('workflow.stats.nodes') }} · {{ workflow.edges.length }} {{ t('workflow.stats.edges') }}</span>
          </span>
          <NPopconfirm
            v-if="!isWorkflowBatchMode"
            @positive-click="handleWorkflowDelete(workflow.id)"
          >
            <template #trigger>
              <button
                class="workflow-list-delete"
                type="button"
                :title="t('common.delete')"
                :disabled="deletingWorkflowIds.has(workflow.id)"
                @click.stop.prevent
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </template>
            {{ t('workflow.batch.confirmDelete', { count: 1 }) }}
          </NPopconfirm>
        </button>
      </div>
      <PageSidebarFooter v-if="showWorkflowSidebar" />
    </aside>

    <main class="workflow-main">
      <header class="page-header">
        <div class="header-left">
          <NButton
            class="header-sidebar-toggle"
            quaternary
            size="small"
            circle
            @click="showWorkflowSidebar = !showWorkflowSidebar"
          >
            <template #icon>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <div class="header-workflow-meta">
            <span class="header-workflow-title">{{ workflowName }}</span>
            <button class="workspace-badge" type="button" :title="workflowWorkspace || t('workflow.workspace.select')" @click="openWorkspacePicker('active')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span>{{ workflowWorkspace ? (workflowWorkspace.split('/').pop() || workflowWorkspace) : t('workflow.workspace.select') }}</span>
            </button>
          </div>
        </div>
        <div class="header-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                quaternary
                size="small"
                circle
                :aria-label="showWorkflowRunsPanel ? t('workflow.runs.hide') : t('workflow.runs.show')"
                @click="toggleWorkflowRunsPanel"
              >
                <template #icon>
                  <svg v-if="showWorkflowRunsPanel" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M15 4v16" />
                    <path d="M8 9h4" />
                    <path d="M8 13h4" />
                  </svg>
                  <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M9 4v16" />
                    <path d="M13 9h4" />
                    <path d="M13 13h4" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ showWorkflowRunsPanel ? t('workflow.runs.hide') : t('workflow.runs.show') }}
          </NTooltip>
          <input ref="workflowImportInputRef" class="workflow-import-input" type="file" accept="application/json,.json" @change="handleWorkflowImport" />
          <NTooltip v-if="!selectedWorkflowRunId" trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" circle :aria-label="t('workflow.actions.importWorkflow')" @click="openWorkflowImport">
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 16V5" />
                    <path d="m8 9 4-4 4 4" />
                    <path d="M5 15v4h14v-4" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('workflow.actions.importWorkflow') }}
          </NTooltip>
          <NTooltip v-if="!selectedWorkflowRunId" trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" circle :disabled="!activeWorkflowId" :aria-label="t('workflow.actions.exportWorkflow')" @click="exportActiveWorkflow">
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 3v11" />
                    <path d="m8 10 4 4 4-4" />
                    <path d="M5 15v4h14v-4" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('workflow.actions.exportWorkflow') }}
          </NTooltip>
          <NTooltip v-if="!selectedWorkflowRunId" trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" circle :aria-label="t('workflow.actions.addNode')" @click="addAgentNode">
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('workflow.actions.addNode') }}
          </NTooltip>
          <NTooltip v-if="!selectedWorkflowRunId" trigger="hover">
            <template #trigger>
              <NButton
                quaternary
                size="small"
                circle
                :loading="savingWorkflow"
                :disabled="!activeWorkflowId || executingWorkflow"
                :aria-label="t('common.save')"
                @click="() => saveActiveWorkflow()"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <path d="M17 21v-8H7v8" />
                    <path d="M7 3v5h8" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('common.save') }}
          </NTooltip>
          <NTooltip v-if="!selectedWorkflowRunId" trigger="hover">
            <template #trigger>
              <NButton
                quaternary
                size="small"
                circle
                :loading="executingWorkflow"
                :disabled="!activeWorkflowId || savingWorkflow"
                :aria-label="t('workflow.actions.startExecution')"
                @click="startWorkflowExecution"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('workflow.actions.startExecution') }}
          </NTooltip>
        </div>
      </header>
    <NModal
      v-model:show="workspaceModalVisible"
      preset="card"
      :title="t('workflow.workspace.title')"
      :style="{ width: 'min(720px, calc(100vw - 32px))' }"
    >
      <FolderPicker v-model="workspacePickerValue" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="clearWorkspacePicker">
            {{ t('workflow.workspace.clear') }}
          </NButton>
          <NButton type="primary" @click="workspaceModalVisible = false">
            {{ t('common.confirm') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <div ref="workflowBodyRef" class="workflow-body">
      <aside
        v-if="workflowChatPanelVisible"
        class="workflow-chat-panel"
        :style="workflowChatPanelStyle"
      >
        <div
          class="workflow-chat-resize-handle"
          @pointerdown="startWorkflowChatResize"
        />
        <div class="workflow-chat-panel-inner">
          <header class="workflow-chat-header">
            <div class="workflow-chat-title" :title="workflowChatPanelTitle">
              {{ workflowChatPanelTitle }}
            </div>
            <NButton
              quaternary
              size="tiny"
              circle
              :aria-label="t('common.cancel')"
              @click="closeWorkflowChatPanel"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </template>
            </NButton>
          </header>
          <div class="workflow-chat-content">
            <div v-if="workflowChatPanelLoading" class="workflow-chat-loading">
              {{ t('common.loading') }}
            </div>
            <template v-else-if="workflowChatPanelSessionId">
              <div v-if="workflowChatPanelPendingApproval" class="workflow-node-approval-panel">
                <div class="workflow-node-approval-title">
                  {{ t('workflow.status.pending_approval') }}
                </div>
                <div class="workflow-node-approval-actions">
                  <NButton
                    size="small"
                    :disabled="workflowApprovalSubmitting"
                    @click="respondWorkflowNodeApproval(false)"
                  >
                    {{ t('common.cancel') }}
                  </NButton>
                  <NButton
                    type="primary"
                    size="small"
                    :loading="workflowApprovalSubmitting"
                    @click="respondWorkflowNodeApproval(true)"
                  >
                    {{ t('common.confirm') }}
                  </NButton>
                </div>
              </div>
              <MessageList />
              <ChatInput />
            </template>
            <div v-else class="workflow-chat-loading">
              {{ t('chat.noVisibleMessages') }}
            </div>
          </div>
        </div>
      </aside>
      <section ref="workflowCanvasRef" class="workflow-canvas" aria-label="Workflow canvas">
        <VueFlow
          :key="workflowFlowKey"
          id="hermes-workflow"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :fit-view-on-init="false"
          :default-viewport="defaultViewport"
          :min-zoom="0.25"
          :max-zoom="1.4"
          :nodes-draggable="!selectedWorkflowRunId"
          :nodes-connectable="!selectedWorkflowRunId"
          :elements-selectable="!selectedWorkflowRunId"
          :connection-line-type="ConnectionLineType.SmoothStep"
          :is-valid-connection="isValidWorkflowConnection"
          :default-edge-options="{ type: 'smoothstep', markerEnd: MarkerType.ArrowClosed }"
          class="workflow-flow"
          @connect="handleConnect"
          @connect-start="handleConnectStart"
          @connect-end="handleConnectEnd"
          @node-click="handleNodeClick"
          @node-context-menu="handleNodeContextMenu"
          @edge-click="handleEdgeClick"
          @edge-context-menu="handleEdgeContextMenu"
          @pane-click="closeContextMenu"
        >
          <template #node-agent="nodeProps">
            <WorkflowAgentNode v-bind="nodeProps" />
          </template>

          <Background :gap="24" :size="1.2" color="var(--border-color)" />
          <MiniMap pannable zoomable :node-color="nodeColor" />
          <Controls />
        </VueFlow>
        <NDropdown
          placement="bottom-start"
          trigger="manual"
          :x="contextMenuX"
          :y="contextMenuY"
          :options="contextMenuOptions"
          :show="contextMenuVisible"
          @select="handleContextMenuSelect"
          @clickoutside="handleContextMenuClickOutside"
        />
      </section>
      <aside v-if="showWorkflowRunsPanel" class="workflow-runs-panel">
        <div class="workflow-runs-header">
          <div class="workflow-runs-title">{{ t('workflow.runs.title') }}</div>
          <div class="workflow-runs-header-actions">
            <button class="workflow-runs-refresh" type="button" :title="t('workflow.runs.refresh')" @click="loadWorkflowRuns()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 0 1-15.5 6.2" />
                <path d="M3 12a9 9 0 0 1 15.5-6.2" />
                <path d="M18 3v5h-5" />
                <path d="M6 21v-5h5" />
              </svg>
            </button>
            <button class="workflow-runs-refresh workflow-runs-close" type="button" :title="t('common.cancel')" @click="toggleWorkflowRunsPanel">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div v-if="workflowRunsLoading" class="workflow-runs-empty">{{ t('common.loading') }}</div>
        <div v-else-if="workflowRuns.length === 0" class="workflow-runs-empty">{{ t('workflow.runs.empty') }}</div>
        <div v-else class="workflow-runs-list">
          <button
            v-for="run in workflowRuns"
            :key="run.id"
            class="workflow-run-item"
            :class="{ active: selectedWorkflowRunId === run.id }"
            type="button"
            @click="selectWorkflowRun(run)"
            @contextmenu="openWorkflowRunContextMenu($event, run)"
          >
            <div class="workflow-run-topline">
              <span class="workflow-run-status" :class="workflowRunStatusClass(run.status)">
                <span class="workflow-run-status-dot" />
                <span>{{ workflowRunStatusLabel(run.status) }}</span>
              </span>
              <span class="workflow-run-duration">{{ formatWorkflowRunDuration(run) }}</span>
            </div>
            <div class="workflow-run-time">{{ formatWorkflowRunTime(run.started_at || run.created_at) }}</div>
            <div class="workflow-run-meta">
              {{ workflowRunNodeCount(run) }} {{ t('workflow.stats.nodes') }}
              <span v-if="run.start_node_ids.length > 0">· {{ t('workflow.runs.startNodes', { count: run.start_node_ids.length }) }}</span>
            </div>
            <div v-if="run.error" class="workflow-run-error" :title="run.error">{{ run.error }}</div>
          </button>
        </div>
        <section
          v-if="selectedWorkflowRun"
          class="workflow-evidence"
          :class="{ expanded: workflowEvidenceExpanded }"
          :aria-label="t('workflow.evidence.ariaLabel')"
        >
          <button
            type="button"
            class="workflow-evidence-toggle"
            :aria-expanded="workflowEvidenceExpanded"
            @click="workflowEvidenceExpanded = !workflowEvidenceExpanded"
          >
            <span class="workflow-evidence-title">
              {{ t('workflow.evidence.title') }}
              <span>{{ t('workflow.evidence.count', { count: selectedWorkflowEvidenceRows.length }) }}</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path :d="workflowEvidenceExpanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'" />
            </svg>
          </button>
          <template v-if="workflowEvidenceExpanded">
            <p class="workflow-evidence-intro">{{ t('workflow.evidence.intro') }}</p>
            <div v-if="selectedWorkflowEvidenceRows.length === 0" class="workflow-runs-empty">{{ t('workflow.evidence.empty') }}</div>
            <div v-else class="workflow-evidence-list">
              <article v-for="row in selectedWorkflowEvidenceRows" :key="`${row.kind}:${row.sequence}:${row.technicalId}`" class="workflow-evidence-row">
                <div class="workflow-evidence-topline">
                  <span class="workflow-evidence-kind">{{ t(`workflow.evidence.${row.kind}`) }}</span>
                  <span class="workflow-evidence-status">{{ workflowEvidenceStatusLabel(row) }}</span>
                </div>
                <strong>{{ workflowEvidenceTitle(row) }}</strong>
                <span class="workflow-evidence-description">{{ workflowEvidenceDescription(row) }}</span>
                <details class="workflow-evidence-technical">
                  <summary>{{ t('workflow.evidence.technical') }}</summary>
                  <dl>
                    <dt>{{ t('workflow.evidence.recordId') }}</dt><dd><code>{{ row.technicalId }}</code></dd>
                    <dt>{{ t('workflow.evidence.sequence') }}</dt><dd>#{{ row.sequence }}</dd>
                    <dt>{{ t('workflow.evidence.rawStatus') }}</dt><dd><code>{{ row.status }}</code></dd>
                    <template v-if="row.route">
                      <dt>{{ t('workflow.evidence.rawRoute') }}</dt><dd><code>{{ row.route }}</code></dd>
                    </template>
                    <template v-if="row.reason || row.exitReason">
                      <dt>{{ t('workflow.evidence.rawReason') }}</dt><dd><code>{{ row.reason || row.exitReason }}</code></dd>
                    </template>
                    <template v-if="row.iterationPath !== '—'">
                      <dt>{{ t('workflow.evidence.iterationPath') }}</dt><dd><code>{{ row.iterationPath }}</code></dd>
                    </template>
                  </dl>
                </details>
              </article>
            </div>
          </template>
        </section>
        <NDropdown
          placement="bottom-start"
          trigger="manual"
          :x="workflowRunContextMenuX"
          :y="workflowRunContextMenuY"
          :options="workflowRunContextMenuOptions"
          :show="workflowRunContextMenuVisible"
          @select="handleWorkflowRunContextMenuSelect"
          @clickoutside="closeWorkflowRunContextMenu"
        />
      </aside>
    </div>
    </main>

    <NModal :show="workflowImportConfirmVisible" preset="card" :mask-closable="false" @esc="dismissPendingWorkflowImport" @close="dismissPendingWorkflowImport" :title="t('workflow.actions.importWorkflow')" style="width: min(520px, 92vw)">
      <div v-if="workflowImportPreview" class="workflow-create-form">
        <p data-testid="workflow-import-summary">{{ workflowImportConfirmationText(workflowImportPreview.summary, { nodes: t('workflow.stats.nodes').toLocaleLowerCase(), edges: t('workflow.stats.edges').toLocaleLowerCase() }) }}</p>
        <NSpace justify="end"><NButton @click="dismissPendingWorkflowImport">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="workflowImportConfirming" data-testid="workflow-import-confirm" @click="confirmPendingWorkflowImport">{{ t('common.confirm') }}</NButton></NSpace>
      </div>
    </NModal>

    <NModal v-model:show="edgeEditorVisible" preset="card" :title="t('workflow.edgeEditor.title')" style="width: min(680px, 94vw)">
      <div class="workflow-create-form workflow-edge-editor-form">
        <div class="workflow-edge-guide" data-testid="workflow-edge-guide">{{ t('workflow.edgeEditor.guideIntro') }}</div>
        <div class="workflow-field">
          <span class="workflow-field-label-row">
            <span class="workflow-field-label">{{ t('workflow.edgeEditor.route') }}</span>
            <WorkflowFieldHelp
              :text="t('workflow.edgeEditor.routeHelp')"
              :secondary-text="t('workflow.edgeEditor.routeExample')"
              test-id="workflow-edge-route-help"
            />
          </span>
          <NSelect :value="edgeEditorRoute" :options="workflowEdgeRouteOptions" @update:value="handleEdgeEditorRouteChange" />
        </div>
        <div class="workflow-field">
          <span class="workflow-field-label-row">
            <span class="workflow-field-label">{{ t('workflow.edgeEditor.conditionPath') }}</span>
            <WorkflowFieldHelp
              :text="t(`workflow.edgeEditor.conditionPathHelp.${edgeEditorRoute}`)"
              test-id="workflow-edge-condition-path-help"
            />
          </span>
          <NSelect
            :value="edgeEditorConditionPathPreset"
            :options="workflowConditionPathOptions"
            data-testid="workflow-edge-condition-path-preset"
            @update:value="setConditionPathPreset"
          />
          <NInput
            v-if="edgeEditorConditionPathPreset === 'custom'"
            v-model:value="edgeEditorConditionPath"
            data-testid="workflow-edge-condition-path"
            :placeholder="t('workflow.edgeEditor.conditionPathPlaceholder')"
          />
        </div>
        <div v-if="edgeEditorConditionPathPreset !== 'route-only'" class="workflow-field">
          <span class="workflow-field-label-row">
            <span class="workflow-field-label">{{ t('workflow.edgeEditor.operator') }}</span>
            <WorkflowFieldHelp :text="workflowEdgeOperatorHelp" test-id="workflow-edge-operator-help" />
          </span>
          <NSelect
            :value="edgeEditorConditionOperator"
            data-testid="workflow-edge-condition-operator"
            :options="workflowEdgeOperatorOptions"
            @update:value="handleEdgeEditorOperatorChange"
          />
        </div>
        <template v-if="edgeEditorConditionPathPreset !== 'route-only' && workflowConditionNeedsValue(edgeEditorConditionOperator)">
          <div class="workflow-field">
            <span class="workflow-field-label-row">
              <span class="workflow-field-label">{{ t('workflow.edgeEditor.valueType') }}</span>
              <WorkflowFieldHelp :text="t('workflow.edgeEditor.valueTypeHelp')" test-id="workflow-edge-condition-value-type-help" />
            </span>
            <NSelect
              :value="edgeEditorConditionValueType"
              :options="workflowConditionValueTypeOptions"
              :disabled="workflowConditionValueTypeDisabled"
              data-testid="workflow-edge-condition-value-type"
              @update:value="handleEdgeEditorValueTypeChange"
            />
          </div>
          <div class="workflow-field">
            <span class="workflow-field-label-row">
              <span class="workflow-field-label">{{ t('workflow.edgeEditor.value') }}</span>
              <WorkflowFieldHelp :text="t('workflow.edgeEditor.valueHelp')" test-id="workflow-edge-condition-value-help" />
            </span>
            <NInput
              v-model:value="edgeEditorConditionValue"
              data-testid="workflow-edge-condition-value"
              :disabled="edgeEditorConditionValueType === 'null'"
              :placeholder="workflowConditionValuePlaceholder"
              :status="workflowConditionValueError ? 'error' : undefined"
            />
            <span v-if="workflowConditionValueError" class="workflow-field-error" data-testid="workflow-edge-condition-value-error">{{ workflowConditionValueError }}</span>
          </div>
        </template>
        <div class="workflow-feedback-field">
          <div class="workflow-feedback-heading">
            <NCheckbox v-model:checked="edgeEditorFeedback">{{ t('workflow.edgeEditor.feedback') }}</NCheckbox>
            <WorkflowFieldHelp :text="t('workflow.edgeEditor.feedbackHelp')" test-id="workflow-edge-feedback-help" />
          </div>
        </div>
        <div v-if="edgeEditorFeedback" class="workflow-field">
          <span class="workflow-field-label-row">
            <span class="workflow-field-label">{{ t('workflow.edgeEditor.maxIterations') }}</span>
            <WorkflowFieldHelp :text="t('workflow.edgeEditor.maxIterationsHelp')" test-id="workflow-edge-max-iterations-help" />
          </span>
          <NInput v-model:value="edgeEditorMaxIterations" inputmode="numeric" />
        </div>
        <div v-if="edgeEditorFeedback" class="workflow-field">
          <span class="workflow-field-label-row">
            <span class="workflow-field-label">{{ t('workflow.edgeEditor.loopId') }}</span>
            <WorkflowFieldHelp :text="t('workflow.edgeEditor.loopIdHelp')" test-id="workflow-edge-loop-id-help" />
          </span>
          <NSelect
            v-model:value="edgeEditorLoopIdSelection"
            :options="workflowLoopIdOptions"
            tag
            filterable
            data-testid="workflow-edge-loop-id"
            :placeholder="t('workflow.edgeEditor.loopIdPlaceholder')"
          />
        </div>
        <NSpace justify="end"><NButton @click="edgeEditorVisible = false">{{ t('common.cancel') }}</NButton><NButton type="primary" :disabled="Boolean(workflowConditionValueError)" @click="saveEdgeEditor">{{ t('common.save') }}</NButton></NSpace>
      </div>
    </NModal>

    <NDrawer v-model:show="createWorkflowDrawerVisible" placement="right" :width="420">
      <NDrawerContent :title="t('workflow.actions.newWorkflow')" closable>
        <div class="workflow-create-form">
          <label class="workflow-field">
            <span class="workflow-field-label">{{ t('workflow.namePlaceholder') }}</span>
            <NInput
              v-model:value="createWorkflowName"
              :placeholder="t('workflow.namePlaceholder')"
              @keydown.enter.prevent="submitCreateWorkflow"
            />
          </label>
          <label class="workflow-field">
            <span class="workflow-field-label">{{ t('workflow.profile') }}</span>
            <NSelect
              v-model:value="createWorkflowProfile"
              :options="workflowProfileOptions"
              :loading="profilesStore.loading"
            />
          </label>
          <div class="workflow-field">
            <span class="workflow-field-label">{{ t('workflow.workspace.select') }}</span>
            <FolderPicker v-model="createWorkflowWorkspace" />
          </div>
        </div>
        <template #footer>
          <NSpace justify="end">
            <NButton @click="createWorkflowDrawerVisible = false">
              {{ t('common.cancel') }}
            </NButton>
            <NButton type="primary" :loading="creatingWorkflow" @click="submitCreateWorkflow">
              {{ t('common.create') }}
            </NButton>
          </NSpace>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-view {
  height: calc(100 * var(--vh));
  display: flex;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.workflow-main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.workflow-sidebar {
  width: $sidebar-width;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px;
  border-bottom: 1px solid $border-color;
}

.workflow-list-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.workflow-profile-filter {
  min-width: 0;
  flex: 1;
}

.workflow-list-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}

.workflow-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 6px 12px;
}

.workflow-list-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.workflow-list-item {
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: $text-secondary;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &:hover .workflow-list-delete,
  &:focus-within .workflow-list-delete {
    opacity: 1;
    pointer-events: auto;
  }

  &.active,
  &.selected {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 500;
    border-radius: 6px;
  }

  &.active .workflow-list-name,
  &.selected .workflow-list-name {
    color: var(--accent-primary);
  }
}

.workflow-select-indicator {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workflow-list-avatar-wrap {
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workflow-list-avatar-wrap.streaming::before {
  content: "";
  position: absolute;
  inset: -2px;
  box-sizing: border-box;
  border-radius: 50%;
  box-shadow:
    0 0 0 2px #ff6b6b,
    0 0 10px rgba(255, 107, 107, 0.4),
    0 0 20px rgba(255, 107, 107, 0.2);
  animation: workflow-avatar-glow 4s linear infinite;
}

.workflow-list-avatar {
  position: relative;
  z-index: 1;
}

@keyframes workflow-avatar-glow {
  0% {
    filter: hue-rotate(0deg);
    opacity: 0.95;
  }
  50% {
    opacity: 0.65;
  }
  100% {
    filter: hue-rotate(360deg);
    opacity: 0.95;
  }
}

.workflow-list-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workflow-list-name,
.workflow-list-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-list-name {
  font-size: 13px;
  line-height: 18px;
  color: inherit;
}

.workflow-list-meta {
  font-size: 11px;
  line-height: 15px;
  color: $text-muted;
}

.workflow-list-delete {
  flex-shrink: 0;
  opacity: 0;
  pointer-events: none;
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  transition: all var(--transition-fast);

  &:hover {
    color: var(--error);
    background: rgba(var(--error-rgb), 0.1);
  }
}

@media (hover: none) {
  .workflow-list-delete {
    opacity: 0.5;
    pointer-events: auto;
  }
}

.workflow-evidence {
  flex: 0 0 auto;
  min-height: 0;
  border-top: 1px solid var(--border-color);
  background: $bg-card;
}
.workflow-evidence.expanded {
  flex-basis: 45%;
  max-height: 45%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.workflow-evidence-toggle {
  width: 100%;
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  text-align: left;
}
.workflow-evidence-toggle:hover { background: rgba(var(--accent-primary-rgb), 0.06); color: var(--text-primary); }
.workflow-evidence-title { min-width: 0; font-size: 12px; font-weight: 600; }
.workflow-evidence-title > span { margin-left: 4px; color: var(--text-muted); font-weight: 400; }
.workflow-evidence-intro { flex: 0 0 auto; margin: 0; padding: 0 12px 8px; color: var(--text-muted); font-size: 11px; line-height: 16px; }
.workflow-evidence-list { min-height: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.workflow-evidence-row { flex: 0 0 auto; display: flex; flex-direction: column; gap: 3px; padding: 7px 8px; border-radius: 6px; background: rgba(var(--accent-primary-rgb), 0.05); font-size: 11px; color: var(--text-muted); }
.workflow-evidence-row strong, .workflow-evidence-description { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-evidence-row strong { color: var(--text-primary); font-size: 12px; }
.workflow-evidence-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.workflow-evidence-kind { font-weight: 600; }
.workflow-evidence-status { color: var(--text-secondary); }
.workflow-evidence-technical { margin-top: 2px; }
.workflow-evidence-technical summary { width: fit-content; color: var(--text-muted); cursor: pointer; }
.workflow-evidence-technical dl { margin: 6px 0 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 6px; }
.workflow-evidence-technical dt { color: var(--text-muted); }
.workflow-evidence-technical dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.workflow-evidence-technical code { color: var(--accent-primary); }

.workflow-create-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.workflow-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.workflow-field-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  color: $text-secondary;
}

.workflow-edge-editor-form {
  max-height: min(720px, calc(100vh - 180px));
  overflow-y: auto;
  padding-right: 6px;
}

.workflow-edge-guide {
  padding: 10px 12px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.28);
  border-radius: 8px;
  background: rgba(var(--accent-info-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
}

.workflow-field-label-row,
.workflow-feedback-heading {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
}

.workflow-field-error {
  color: #dc2626;
  font-size: 12px;
  line-height: 1.4;
}

.workflow-feedback-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.header-sidebar-toggle {
  flex: 0 0 auto;
}

.header-workflow-meta {
  min-width: 0;
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  overflow: hidden;
}

.header-workflow-title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(520px, 52vw);
  margin-left: 10px;
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  color: $text-primary;
}

.workspace-badge {
  flex: 0 1 auto;
  max-width: 160px;
  min-width: 0;
  border: 0;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: $text-muted;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  overflow: hidden;

  svg {
    flex: 0 0 auto;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workflow-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.workflow-import-input { display: none; }

.workflow-canvas {
  min-width: 0;
  min-height: 0;
  background: $bg-primary;
  flex: 1;
}

.workflow-runs-panel {
  width: 280px;
  flex: 0 0 280px;
  min-height: 0;
  border-left: 1px solid $border-color;
  background: $bg-card;
  display: flex;
  flex-direction: column;
}

.workflow-chat-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 320px;
  max-width: 100%;
  min-height: 0;
  border-right: 1px solid $border-color;
  background: $bg-card;
  display: flex;
  overflow: visible;
}

.workflow-chat-resize-handle {
  position: absolute;
  right: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    right: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    right: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      $bg-card;
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      $bg-card;
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.workflow-chat-panel-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workflow-chat-header {
  flex: 0 0 auto;
  min-height: 47px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid $border-color;
}

.workflow-chat-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.workflow-chat-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: $bg-primary;
}

.workflow-chat-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  font-size: 13px;
}

.workflow-node-approval-panel {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid $border-color;
  background: rgba(217, 119, 6, 0.08);
}

.workflow-node-approval-title {
  min-width: 0;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.workflow-node-approval-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.workflow-runs-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid $border-light;
}

.workflow-runs-title {
  min-width: 0;
  flex: 1;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.workflow-runs-header-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.workflow-runs-refresh {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.workflow-runs-empty {
  padding: 18px 12px;
  color: $text-muted;
  font-size: 12px;
  text-align: center;
}

.workflow-runs-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workflow-run-item {
  border: 1px solid $border-light;
  border-radius: 8px;
  background: $bg-secondary;
  color: inherit;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  cursor: pointer;
  transition: border-color $transition-fast, background-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.45);
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    border-color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.workflow-run-topline,
.workflow-run-status,
.workflow-run-meta {
  display: flex;
  align-items: center;
}

.workflow-run-topline {
  justify-content: space-between;
  gap: 8px;
}

.workflow-run-status {
  min-width: 0;
  gap: 6px;
  color: $text-primary;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}

.workflow-run-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: #9ca3af;
}

.workflow-run-status.status-queued .workflow-run-status-dot {
  background: #64748b;
}

.workflow-run-status.status-running .workflow-run-status-dot {
  background: #2563eb;
  box-shadow: 0 0 8px rgba(37, 99, 235, 0.65);
}

.workflow-run-status.status-completed .workflow-run-status-dot {
  background: #16a34a;
}

.workflow-run-status.status-failed .workflow-run-status-dot {
  background: #dc2626;
}

.workflow-run-status.status-canceled .workflow-run-status-dot {
  background: #f97316;
}

.workflow-run-duration,
.workflow-run-time,
.workflow-run-meta,
.workflow-run-error {
  font-size: 11px;
  line-height: 15px;
}

.workflow-run-duration,
.workflow-run-time,
.workflow-run-meta {
  color: $text-muted;
}

.workflow-run-meta {
  gap: 4px;
}

.workflow-run-error {
  color: var(--error);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-flow {
  width: 100%;
  height: 100%;
  background: $bg-primary;

  :deep(.vue-flow__node) {
    cursor: grab;
  }

  :deep(.vue-flow__node.dragging) {
    cursor: grabbing;
  }

  :deep(.vue-flow__edge-path) {
    stroke: var(--accent-info);
    stroke-width: 2;
    stroke-dasharray: 6 6;
  }

  :deep(.vue-flow__edge.animated .vue-flow__edge-path) {
    stroke-dasharray: 6;
  }

  :deep(.vue-flow__minimap) {
    border: 1px solid $border-color;
    border-radius: 8px;
    background: $bg-card;
  }

  :deep(.vue-flow__controls) {
    border: 1px solid $border-color;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: none;
  }

  :deep(.vue-flow__controls-button) {
    background: $bg-card;
    border-bottom-color: $border-light;
    color: $text-primary;
  }
}

@media (max-width: $breakpoint-mobile) {
  .workflow-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 120;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: $sidebar-width;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }

  .workflow-sidebar-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .page-header {
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    padding: 16px 12px !important;
  }

  .header-actions {
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: 4px;
  }

  .header-left {
    flex: 1 1 auto;
    min-width: 0;
    gap: 8px;
    align-items: center;
    overflow: hidden;
  }

  .header-workflow-meta {
    flex: 1 1 auto;
    min-width: 0;
    align-items: center;
    gap: 8px;
  }

  .header-workflow-title {
    display: none;
  }

  .workspace-badge {
    flex: 1 1 auto;
    max-width: none;
    padding: 2px 6px;
  }

  .workflow-body {
    min-height: 420px;
  }

  .workflow-runs-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 70;
    width: min(340px, 88vw);
    flex: none;
    min-height: 0;
    border-left: 1px solid $border-color;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.16);
    display: flex;
  }

  .workflow-chat-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 80;
    width: 100% !important;
    min-width: 0;
    border-right: none;
    box-shadow: none;
  }

  .workflow-chat-resize-handle {
    display: none;
  }
}
</style>
