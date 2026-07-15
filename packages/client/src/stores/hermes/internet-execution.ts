import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/internet-execution'
import type {
  InspectBilibiliInput, InternetActionResponseDto, InternetEvidenceDto, InternetOverviewDto,
  InternetReceiptDto, InternetWorkflowDetailDto, InternetWorkflowSummaryDto, SearchBilibiliInput,
} from '@/api/hermes/internet-execution'

type Resource = 'overview' | 'receipts' | 'receipt' | 'workflow'
type VisibleWorkflow = InternetWorkflowSummaryDto | InternetWorkflowDetailDto
const DASHBOARD_REFRESH_FAILED = 'INTERNET_DASHBOARD_REFRESH_FAILED'
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export const useInternetExecutionStore = defineStore('internet-execution', () => {
  const overview = ref<InternetOverviewDto | null>(null)
  const receipts = ref<InternetReceiptDto[]>([])
  const selectedReceipt = ref<InternetReceiptDto | null>(null)
  const evidence = ref<InternetEvidenceDto[]>([])
  const workflows = ref<Record<string, VisibleWorkflow>>({})
  const selectedWorkflowId = ref<string | null>(null)
  const selectedWorkflow = computed(() => selectedWorkflowId.value
    ? workflows.value[selectedWorkflowId.value] ?? null : null)
  const latestResult = computed(() => selectedReceipt.value?.result ?? null)
  const takeoverRequired = computed(() => selectedReceipt.value?.status === 'waiting_user'
    || selectedWorkflow.value?.state === 'waiting_user')
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const resourceErrors = ref<Record<Resource, string | null>>({
    overview: null, receipts: null, receipt: null, workflow: null,
  })
  const mutationError = ref<string | null>(null)
  const error = computed(() => Object.values(resourceErrors.value).find(Boolean) ?? mutationError.value)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)

  let generation = 0
  let mutationSequence = 0
  const sequences: Record<Resource, number> = { overview: 0, receipts: 0, receipt: 0, workflow: 0 }
  const queues = new Map<string, Promise<unknown>>()

  function beginLoad(resource: Resource) {
    const operation = { generation, resource, sequence: ++sequences[resource] }
    activeLoads.value += 1
    resourceErrors.value[resource] = null
    return operation
  }
  function isCurrent(operation: ReturnType<typeof beginLoad>) {
    return operation.generation === generation && operation.sequence === sequences[operation.resource]
  }
  function finishLoad(operation: ReturnType<typeof beginLoad>) {
    if (operation.generation === generation) activeLoads.value = Math.max(0, activeLoads.value - 1)
  }
  function failLoad(operation: ReturnType<typeof beginLoad>, cause: unknown) {
    if (isCurrent(operation)) resourceErrors.value[operation.resource] = errorMessage(cause)
  }
  async function loadOverview() {
    const operation = beginLoad('overview')
    try {
      const value = await api.fetchInternetOverview()
      if (isCurrent(operation)) overview.value = value
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadReceipts() {
    const operation = beginLoad('receipts')
    try {
      const value = await api.fetchInternetReceipts({ limit: 100 })
      if (isCurrent(operation)) receipts.value = value.slice()
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadReceipt(id: string) {
    const operation = beginLoad('receipt')
    try {
      const value = await api.fetchInternetReceipt(id)
      if (isCurrent(operation)) { selectedReceipt.value = value.receipt; evidence.value = value.evidence.slice() }
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadWorkflow(id: string) {
    const operation = beginLoad('workflow')
    try {
      const value = await api.fetchInternetWorkflow(id)
      if (isCurrent(operation)) workflows.value = { ...workflows.value, [value.id]: value }
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadDashboard() {
    const results = await Promise.allSettled([loadOverview(), loadReceipts()])
    if (results.some(result => result.status === 'rejected')) throw new Error(DASHBOARD_REFRESH_FAILED)
  }
  function rememberAction(action: InternetActionResponseDto): InternetActionResponseDto {
    workflows.value = { ...workflows.value, [action.workflow.id]: action.workflow }
    selectedWorkflowId.value = action.workflow.id
    selectedReceipt.value = null
    evidence.value = []
    return action
  }
  function mutate<T>(key: string, write: () => Promise<T>, accept?: (value: T) => void): Promise<T> {
    const callGeneration = generation
    const callSequence = ++mutationSequence
    activeSaves.value += 1
    mutationError.value = null
    const run = async () => {
      try {
        const value = await write()
        if (callGeneration === generation) accept?.(value)
        return value
      } catch (cause) {
        if (callGeneration === generation && callSequence === mutationSequence) mutationError.value = errorMessage(cause)
        throw cause
      } finally {
        if (callGeneration === generation) activeSaves.value = Math.max(0, activeSaves.value - 1)
      }
    }
    const prior = queues.get(key)
    const task = prior ? prior.catch(() => undefined).then(run) : run()
    queues.set(key, task)
    void task.finally(() => { if (queues.get(key) === task) queues.delete(key) }).catch(() => undefined)
    return task
  }
  function search(input: SearchBilibiliInput) {
    return mutate('bilibili', () => api.searchBilibiliVideos(input), rememberAction)
  }
  function inspect(input: InspectBilibiliInput) {
    return mutate('bilibili', () => api.inspectBilibiliVideo(input), rememberAction)
  }
  function selectWorkflow(id: string | null) { selectedWorkflowId.value = id; return selectedWorkflow.value }
  function selectReceipt(receipt: InternetReceiptDto | null) {
    selectedReceipt.value = receipt
    evidence.value = []
    selectedWorkflowId.value = receipt?.workflowId ?? null
  }
  function clearResourceError(resource: Resource) { resourceErrors.value[resource] = null }
  function reset() {
    generation += 1; mutationSequence += 1
    for (const resource of Object.keys(sequences) as Resource[]) sequences[resource] += 1
    overview.value = null; receipts.value = []; selectedReceipt.value = null; evidence.value = []
    workflows.value = {}; selectedWorkflowId.value = null; activeLoads.value = 0; activeSaves.value = 0
    resourceErrors.value = { overview: null, receipts: null, receipt: null, workflow: null }
    mutationError.value = null; queues.clear()
  }
  onScopeDispose(() => {
    generation += 1; mutationSequence += 1
    for (const resource of Object.keys(sequences) as Resource[]) sequences[resource] += 1
    queues.clear()
  })

  return {
    overview, receipts, selectedReceipt, evidence, workflows, selectedWorkflowId, selectedWorkflow,
    latestResult, takeoverRequired, loading, saving, error, resourceErrors,
    loadOverview, loadReceipts, loadReceipt, loadWorkflow, loadDashboard,
    search, inspect, selectWorkflow, selectReceipt, clearResourceError, $reset: reset,
  }
})
