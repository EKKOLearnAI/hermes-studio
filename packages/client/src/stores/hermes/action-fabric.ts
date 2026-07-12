import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import * as actionFabricApi from '@/api/hermes/action-fabric'
import type {
  ActionAuditEventDto,
  ActionCapabilityDto,
  ActionControlDto,
  ActionExecutorDto,
  ActionWorkflowDetailDto,
  ActionWorkflowSummaryDto,
  AuditQuery,
  CreateActionIntentInput,
  EmergencyStopInput,
  WorkflowQuery,
} from '@/api/hermes/action-fabric'

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isNotFound(error: unknown): boolean { return error instanceof Error && /(?:API Error )?404\b/.test(error.message) }
const ACTION_FABRIC_REFRESH_FAILED = 'ACTION_FABRIC_REFRESH_FAILED'

export const useActionFabricStore = defineStore('action-fabric', () => {
  const capabilities = ref<ActionCapabilityDto[]>([])
  const executors = ref<ActionExecutorDto[]>([])
  const workflows = ref<ActionWorkflowSummaryDto[]>([])
  const selectedWorkflowId = ref<string | null>(null)
  const selectedWorkflow = ref<ActionWorkflowDetailDto | null>(null)
  const audit = ref<ActionAuditEventDto[]>([])
  const control = ref<ActionControlDto | null>(null)
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)
  const error = ref<string | null>(null)

  let generation = 0
  let errorSequence = 0
  let capabilitySequence = 0
  let executorSequence = 0
  let workflowListSequence = 0
  let selectionGeneration = 0
  const detailSequences = new Map<string, number>()
  let auditSequence = 0
  let controlSequence = 0
  let mutationSequence = 0
  let lastWorkflowQuery: WorkflowQuery = { limit: 100 }
  let lastAuditQuery: AuditQuery = { limit: 100 }

  watch(selectedWorkflowId, () => {
    selectionGeneration += 1
    selectedWorkflow.value = null
  }, { flush: 'sync' })

  function beginLoad(reportError = true) {
    const currentGeneration = generation
    const currentError = reportError ? ++errorSequence : null
    activeLoads.value += 1
    if (reportError) error.value = null
    return { generation: currentGeneration, error: currentError }
  }
  function finishLoad(operation: { generation: number }): void {
    if (operation.generation === generation) activeLoads.value = Math.max(0, activeLoads.value - 1)
  }
  function recordError(operation: { generation: number; error: number | null }, cause: unknown): void {
    if (operation.generation === generation && operation.error !== null && operation.error === errorSequence) {
      error.value = errorMessage(cause)
    }
  }

  async function loadCapabilities(): Promise<ActionCapabilityDto[]> {
    const sequence = ++capabilitySequence
    const operation = beginLoad()
    try {
      const result = await actionFabricApi.fetchActionCapabilities({ limit: 200 })
      if (operation.generation === generation && sequence === capabilitySequence) capabilities.value = result
      return result
    } catch (cause) { recordError(operation, cause); throw cause } finally { finishLoad(operation) }
  }

  async function loadExecutors(): Promise<ActionExecutorDto[]> {
    const sequence = ++executorSequence
    const operation = beginLoad()
    try {
      const result = await actionFabricApi.fetchActionExecutors({ limit: 200 })
      if (operation.generation === generation && sequence === executorSequence) executors.value = result
      return result
    } catch (cause) { recordError(operation, cause); throw cause } finally { finishLoad(operation) }
  }

  async function loadWorkflowsInternal(options: WorkflowQuery | undefined, invalidateSelection: boolean,
    reportError: boolean): Promise<ActionWorkflowSummaryDto[]> {
    const query = options ? { limit: 100, ...options } : { ...lastWorkflowQuery }
    if (options) lastWorkflowQuery = query
    const sequence = ++workflowListSequence
    const selectionAtStart = selectionGeneration
    const operation = beginLoad(reportError)
    try {
      const result = await actionFabricApi.fetchActionWorkflows(query)
      if (operation.generation === generation && sequence === workflowListSequence) {
        workflows.value = result.workflows
        if (invalidateSelection && selectionGeneration === selectionAtStart && selectedWorkflowId.value
          && !result.workflows.some(item => item.id === selectedWorkflowId.value)) {
          selectedWorkflowId.value = null
          selectedWorkflow.value = null
        }
      }
      return result.workflows
    } catch (cause) { recordError(operation, cause); throw cause } finally { finishLoad(operation) }
  }

  function loadWorkflows(options?: WorkflowQuery): Promise<ActionWorkflowSummaryDto[]> {
    return loadWorkflowsInternal(options, true, true)
  }

  async function loadWorkflowInternal(id: string, reportError: boolean): Promise<ActionWorkflowDetailDto> {
    const sequence = (detailSequences.get(id) ?? 0) + 1
    detailSequences.set(id, sequence)
    const selectionAtStart = selectionGeneration
    const operation = beginLoad(reportError)
    try {
      const result = await actionFabricApi.fetchActionWorkflow(id)
      if (operation.generation === generation && sequence === detailSequences.get(id)
        && selectionGeneration === selectionAtStart && selectedWorkflowId.value === id) {
        selectedWorkflow.value = result
      }
      return result
    } catch (cause) {
      if (operation.generation === generation && sequence === detailSequences.get(id)
        && selectionGeneration === selectionAtStart && selectedWorkflowId.value === id && isNotFound(cause)) {
        selectedWorkflowId.value = null
      }
      recordError(operation, cause)
      throw cause
    } finally { finishLoad(operation) }
  }

  function loadWorkflow(id: string): Promise<ActionWorkflowDetailDto> {
    return loadWorkflowInternal(id, true)
  }

  async function selectWorkflow(id: string | null): Promise<ActionWorkflowDetailDto | null> {
    selectedWorkflowId.value = id
    if (id === null) return null
    return loadWorkflow(id)
  }

  async function loadAuditInternal(options: AuditQuery | undefined, reportError: boolean): Promise<ActionAuditEventDto[]> {
    const query = options ? { limit: 100, ...options } : { ...lastAuditQuery }
    if (options) lastAuditQuery = query
    const sequence = ++auditSequence
    const operation = beginLoad(reportError)
    try {
      const result = await actionFabricApi.fetchActionAudit(query)
      const events = result.events.slice()
      if (operation.generation === generation && sequence === auditSequence) audit.value = events.slice()
      return events
    } catch (cause) { recordError(operation, cause); throw cause } finally { finishLoad(operation) }
  }

  function loadAudit(options?: AuditQuery): Promise<ActionAuditEventDto[]> {
    return loadAuditInternal(options, true)
  }

  async function loadControlInternal(reportError: boolean): Promise<ActionControlDto> {
    const sequence = ++controlSequence
    const operation = beginLoad(reportError)
    try {
      const result = await actionFabricApi.fetchActionControl()
      if (operation.generation === generation && sequence === controlSequence) control.value = result
      return result
    } catch (cause) { recordError(operation, cause); throw cause } finally { finishLoad(operation) }
  }

  function loadControl(): Promise<ActionControlDto> {
    return loadControlInternal(true)
  }

  async function verifyAudit() { return actionFabricApi.verifyActionAudit() }

  async function runMutation<T>(operationFn: () => Promise<T>, refresh: (result: T) => Promise<boolean>): Promise<T> {
    const sequence = ++mutationSequence
    const currentGeneration = generation
    const currentError = ++errorSequence
    activeSaves.value += 1
    error.value = null
    try {
      let result: T
      try {
        result = await operationFn()
      } catch (cause) {
        if (currentGeneration === generation && sequence === mutationSequence && currentError === errorSequence) {
          error.value = errorMessage(cause)
        }
        throw cause
      }
      if (currentGeneration === generation) {
        const failed = await refresh(result)
        if (failed && currentGeneration === generation && sequence === mutationSequence
          && currentError === errorSequence) error.value = ACTION_FABRIC_REFRESH_FAILED
      }
      return result
    } finally {
      if (currentGeneration === generation) activeSaves.value = Math.max(0, activeSaves.value - 1)
    }
  }

  async function settleRefresh(tasks: Promise<unknown>[]): Promise<boolean> {
    return (await Promise.allSettled(tasks)).some(result => result.status === 'rejected')
  }

  function refreshWorkflow(id: string): Promise<boolean> {
    return settleRefresh([
      loadWorkflowInternal(id, false), loadWorkflowsInternal(undefined, false, false),
      loadAuditInternal({ aggregateType: 'workflow', aggregateId: id, limit: 100 }, false),
    ])
  }
  function approveWorkflow(id: string) {
    return runMutation(() => actionFabricApi.approveActionWorkflow(id), () => refreshWorkflow(id))
  }
  function rejectWorkflow(id: string, reason: string) {
    return runMutation(() => actionFabricApi.rejectActionWorkflow(id, reason), () => refreshWorkflow(id))
  }
  function cancelWorkflow(id: string, reason: string) {
    return runMutation(() => actionFabricApi.cancelActionWorkflow(id, reason), () => refreshWorkflow(id))
  }
  function retryWorkflow(id: string) {
    return runMutation(() => actionFabricApi.retryActionWorkflow(id), () => refreshWorkflow(id))
  }
  function compensateWorkflow(id: string, reason: string) {
    return runMutation(() => actionFabricApi.compensateActionWorkflow(id, reason), () => refreshWorkflow(id))
  }
  function createIntent(input: CreateActionIntentInput) {
    return runMutation(() => actionFabricApi.createActionIntent(input), result => {
      selectedWorkflowId.value = result.workflow.id
      return refreshWorkflow(result.workflow.id)
    })
  }
  function updateEmergencyStop(input: EmergencyStopInput) {
    return runMutation(() => actionFabricApi.updateActionEmergencyStop(input), () => settleRefresh([
      loadControlInternal(false), loadWorkflowsInternal(undefined, false, false),
      loadAuditInternal({ aggregateType: 'control', limit: 100 }, false),
    ]))
  }

  function reset(): void {
    generation += 1
    errorSequence += 1
    capabilitySequence += 1
    executorSequence += 1
    workflowListSequence += 1
    selectionGeneration += 1
    detailSequences.clear()
    auditSequence += 1
    controlSequence += 1
    mutationSequence += 1
    capabilities.value = []
    executors.value = []
    workflows.value = []
    selectedWorkflowId.value = null
    selectedWorkflow.value = null
    audit.value = []
    control.value = null
    activeLoads.value = 0
    activeSaves.value = 0
    error.value = null
    lastWorkflowQuery = { limit: 100 }
    lastAuditQuery = { limit: 100 }
  }

  onScopeDispose(() => {
    generation += 1
    errorSequence += 1
    capabilitySequence += 1
    executorSequence += 1
    workflowListSequence += 1
    selectionGeneration += 1
    detailSequences.clear()
    auditSequence += 1
    controlSequence += 1
    mutationSequence += 1
  })

  return {
    capabilities, executors, workflows, selectedWorkflowId, selectedWorkflow, audit, control,
    loading, saving, error,
    loadCapabilities, loadExecutors, loadWorkflows, loadWorkflow, selectWorkflow, loadAudit, loadControl, verifyAudit,
    createIntent, approveWorkflow, rejectWorkflow, cancelWorkflow, retryWorkflow, compensateWorkflow,
    updateEmergencyStop, $reset: reset,
  }
})
