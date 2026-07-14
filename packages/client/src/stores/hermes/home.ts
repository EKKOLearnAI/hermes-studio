import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/home'
import type {
  ActivateHomeSceneInput,
  AdjustHomeInventoryInput,
  CommandHomeDeviceInput,
  HomeActionResponseDto,
  HomeDeviceDto,
  HomeInventoryItemDto,
  HomeOverviewDto,
  HomeProviderDto,
  HomeSpaceDto,
  HomeWorkflowDetailDto,
  HomeWorkflowSummaryDto,
  RefreshHomeDeviceInput,
  ReviewHomeWorkflowInput,
  UpsertHomeInventoryInput,
  UpsertHomeSpaceInput,
} from '@/api/hermes/home'

type Resource = 'overview' | 'spaces' | 'devices' | 'inventory' | 'provider' | 'workflow'
type VisibleWorkflow = HomeWorkflowSummaryDto | HomeWorkflowDetailDto
const DASHBOARD_REFRESH_FAILED = 'HOME_DASHBOARD_REFRESH_FAILED'
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export const useHomeStore = defineStore('home', () => {
  const overview = ref<HomeOverviewDto | null>(null)
  const provider = ref<HomeProviderDto | null>(null)
  const spaces = ref<HomeSpaceDto[]>([])
  const devices = ref<HomeDeviceDto[]>([])
  const inventory = ref<HomeInventoryItemDto[]>([])
  const workflows = ref<Record<string, VisibleWorkflow>>({})
  const selectedWorkflowId = ref<string | null>(null)
  const selectedWorkflow = computed(() => selectedWorkflowId.value
    ? workflows.value[selectedWorkflowId.value] ?? null : null)
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const resourceErrors = ref<Record<Resource, string | null>>({
    overview: null, spaces: null, devices: null, inventory: null, provider: null, workflow: null,
  })
  const mutationError = ref<string | null>(null)
  const error = computed(() => Object.values(resourceErrors.value).find(Boolean) ?? mutationError.value)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)
  const lowStockItems = computed(() => inventory.value.filter(item => item.lowStockThreshold !== null
    && item.quantity <= item.lowStockThreshold))
  const unavailableDevices = computed(() => devices.value.filter(device => device.availability !== 'available'))

  let generation = 0
  let mutationSequence = 0
  const sequences: Record<Resource, number> = {
    overview: 0, spaces: 0, devices: 0, inventory: 0, provider: 0, workflow: 0,
  }
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
      const value = await api.fetchHomeOverview()
      if (isCurrent(operation)) { overview.value = value; provider.value = value.provider }
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadProvider() {
    const operation = beginLoad('provider')
    try {
      const value = await api.fetchHomeProvider()
      if (isCurrent(operation)) provider.value = value
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadSpaces() {
    const operation = beginLoad('spaces')
    try {
      const value = await api.fetchHomeSpaces({ limit: 200 })
      if (isCurrent(operation)) spaces.value = value.slice()
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadDevices() {
    const operation = beginLoad('devices')
    try {
      const value = await api.fetchHomeDevices({ limit: 200 })
      if (isCurrent(operation)) devices.value = value.slice()
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadInventory() {
    const operation = beginLoad('inventory')
    try {
      const value = await api.fetchHomeInventory({ limit: 200 })
      if (isCurrent(operation)) inventory.value = value.slice()
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadWorkflow(id: string) {
    const operation = beginLoad('workflow')
    try {
      const value = await api.fetchHomeWorkflow(id)
      if (isCurrent(operation)) workflows.value = { ...workflows.value, [value.id]: value }
      return value
    } catch (cause) { failLoad(operation, cause); throw cause } finally { finishLoad(operation) }
  }
  async function loadDashboard() {
    const results = await Promise.allSettled([loadOverview(), loadSpaces(), loadDevices(), loadInventory()])
    if (results.some(result => result.status === 'rejected')) throw new Error(DASHBOARD_REFRESH_FAILED)
  }

  function rememberAction(action: HomeActionResponseDto): HomeActionResponseDto {
    workflows.value = { ...workflows.value, [action.workflow.id]: action.workflow }
    selectedWorkflowId.value = action.workflow.id
    return action
  }
  function selectWorkflow(id: string | null) { selectedWorkflowId.value = id; return selectedWorkflow.value }
  function replaceInventoryItem(item: HomeInventoryItemDto) {
    const index = inventory.value.findIndex(candidate => candidate.id === item.id)
    inventory.value = index < 0 ? [...inventory.value, item]
      : inventory.value.map(candidate => candidate.id === item.id ? item : candidate)
  }
  function replaceSpace(space: HomeSpaceDto) {
    const index = spaces.value.findIndex(candidate => candidate.id === space.id)
    spaces.value = index < 0 ? [...spaces.value, space]
      : spaces.value.map(candidate => candidate.id === space.id ? space : candidate)
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

  function upsertSpace(input: UpsertHomeSpaceInput) {
    return mutate(`space:${input.id}`, () => api.upsertHomeSpace(input), replaceSpace)
  }
  function upsertInventoryItem(id: string, input: UpsertHomeInventoryInput) {
    return mutate(`inventory:${id}`, () => api.upsertHomeInventoryItem(id, input), replaceInventoryItem)
  }
  function adjustInventory(id: string, input: AdjustHomeInventoryInput) {
    return mutate(`inventory:${id}`, () => api.adjustHomeInventory(id, input), result => replaceInventoryItem(result.item))
  }
  function refreshDevice(id: string, input: RefreshHomeDeviceInput) {
    return mutate(`device:${id}`, () => api.refreshHomeDevice(id, input), rememberAction)
  }
  function commandDevice(id: string, input: CommandHomeDeviceInput) {
    return mutate(`device:${id}`, () => api.commandHomeDevice(id, input), rememberAction)
  }
  function activateScene(id: string, input: ActivateHomeSceneInput) {
    return mutate(`device:${id}`, () => api.activateHomeScene(id, input), rememberAction)
  }
  function reviewWorkflow(id: string, input: ReviewHomeWorkflowInput) {
    return mutate(`workflow:${id}`, () => api.reviewHomeWorkflow(id, input), value => {
      workflows.value = { ...workflows.value, [value.id]: value }
      selectedWorkflowId.value = value.id
    })
  }

  function reset() {
    generation += 1
    mutationSequence += 1
    for (const resource of Object.keys(sequences) as Resource[]) sequences[resource] += 1
    overview.value = null; provider.value = null; spaces.value = []; devices.value = []; inventory.value = []
    workflows.value = {}; selectedWorkflowId.value = null; activeLoads.value = 0; activeSaves.value = 0
    resourceErrors.value = { overview: null, spaces: null, devices: null, inventory: null, provider: null, workflow: null }
    mutationError.value = null; queues.clear()
  }
  onScopeDispose(() => {
    generation += 1; mutationSequence += 1
    for (const resource of Object.keys(sequences) as Resource[]) sequences[resource] += 1
    queues.clear()
  })

  return {
    overview, provider, spaces, devices, inventory, workflows, selectedWorkflowId, selectedWorkflow,
    loading, saving, error, resourceErrors, lowStockItems, unavailableDevices,
    loadOverview, loadProvider, loadSpaces, loadDevices, loadInventory, loadWorkflow, loadDashboard,
    selectWorkflow, upsertSpace, upsertInventoryItem, adjustInventory, refreshDevice, commandDevice,
    activateScene, reviewWorkflow, $reset: reset,
  }
})
