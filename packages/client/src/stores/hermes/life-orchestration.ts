import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/life-orchestration'
import type {
  CancelLifeHoldInput, CancelLifeSubscriptionInput, CreateLifeConstraintInput, CreateLifeHoldInput,
  CreateLifePlanInput, LifeAccountHealth, LifeActionResponseDto, LifeActivationLimitsInput,
  LifeActivationReviewDto, LifeCalendarHoldDto, LifeCancellationDto, LifeCommitmentDto, LifeConstraintDto,
  LifeContactDto, LifeHandoffDto, LifeOptionDto, LifeOverviewDto, LifePlanDto, LifeSourceDto,
  LifeSubscriptionDto, LifeTakeoverDto, LifeWorkflowDetailDto, LifeWorkflowDto, SyncLifeSourceInput,
  VerifyLifePlanInput,
} from '@/api/hermes/life-orchestration'

type Resource = 'dashboard' | 'workflow' | 'reviews'
type VisibleWorkflow = LifeWorkflowDto | LifeWorkflowDetailDto
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export const useLifeOrchestrationStore = defineStore('life-orchestration', () => {
  const overview = ref<LifeOverviewDto | null>(null)
  const commitments = ref<LifeCommitmentDto[]>([])
  const contacts = ref<LifeContactDto[]>([])
  const options = ref<LifeOptionDto[]>([])
  const subscriptions = ref<LifeSubscriptionDto[]>([])
  const constraints = ref<LifeConstraintDto[]>([])
  const plans = ref<LifePlanDto[]>([])
  const handoffs = ref<LifeHandoffDto[]>([])
  const holds = ref<LifeCalendarHoldDto[]>([])
  const cancellations = ref<LifeCancellationDto[]>([])
  const workflows = ref<VisibleWorkflow[]>([])
  const takeovers = ref<LifeTakeoverDto[]>([])
  const activationReviews = ref<LifeActivationReviewDto[]>([])
  const selectedSourceId = ref<string | null>(null)
  const selectedPlanId = ref<string | null>(null)
  const selectedWorkflowId = ref<string | null>(null)
  const selectedSource = computed(() => overview.value?.accounts.find(item => item.id === selectedSourceId.value) ?? null)
  const selectedPlan = computed(() => plans.value.find(item => item.id === selectedPlanId.value) ?? plans.value[0] ?? null)
  const selectedWorkflow = computed(() => workflows.value.find(item => item.id === selectedWorkflowId.value) ?? null)
  const latestConstraint = computed(() => constraints.value[0] ?? null)
  const planMaterialChanged = computed(() => !!selectedPlan.value && !!latestConstraint.value
    && selectedPlan.value.constraintDigest !== latestConstraint.value.materialDigest)
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const resourceErrors = ref<Record<Resource, string | null>>({ dashboard: null, workflow: null, reviews: null })
  const mutationError = ref<string | null>(null)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)
  const error = computed(() => Object.values(resourceErrors.value).find(Boolean) ?? mutationError.value)

  let generation = 0
  let mutationSequence = 0
  const sequences: Record<Resource, number> = { dashboard: 0, workflow: 0, reviews: 0 }
  const queues = new Map<string, Promise<unknown>>()

  function begin(resource: Resource) {
    activeLoads.value += 1; resourceErrors.value[resource] = null
    return { resource, generation, sequence: ++sequences[resource] }
  }
  function current(op: ReturnType<typeof begin>) {
    return op.generation === generation && op.sequence === sequences[op.resource]
  }
  function finish(op: ReturnType<typeof begin>) {
    if (op.generation === generation) activeLoads.value = Math.max(0, activeLoads.value - 1)
  }
  function fail(op: ReturnType<typeof begin>, cause: unknown) {
    if (current(op)) resourceErrors.value[op.resource] = errorText(cause)
  }

  async function loadDashboard(sourceId = selectedSourceId.value) {
    const op = begin('dashboard')
    try {
      const summary = await api.fetchLifeOverview()
      const nextSourceId = sourceId && summary.accounts.some(item => item.id === sourceId)
        ? sourceId : summary.accounts[0]?.id ?? null
      const [nextCommitments, nextContacts, nextOptions, nextSubscriptions, nextConstraints, nextPlans,
        nextHandoffs, nextHolds, nextCancellations, nextWorkflows, nextTakeovers] = await Promise.all([
        api.fetchLifeCommitments(), api.fetchLifeContacts(), api.fetchLifeOptions(),
        api.fetchLifeSubscriptions(), api.fetchLifeConstraints(), api.fetchLifePlans(),
        api.fetchLifeHandoffs(), api.fetchLifeHolds(), api.fetchLifeCancellations(),
        api.fetchLifeWorkflows(), api.fetchLifeTakeovers(),
      ])
      if (current(op)) {
        overview.value = summary; selectedSourceId.value = nextSourceId
        commitments.value = nextCommitments; contacts.value = nextContacts; options.value = nextOptions
        subscriptions.value = nextSubscriptions; constraints.value = nextConstraints; plans.value = nextPlans
        handoffs.value = nextHandoffs; holds.value = nextHolds; cancellations.value = nextCancellations
        workflows.value = nextWorkflows; takeovers.value = nextTakeovers
        if (!selectedPlanId.value || !nextPlans.some(item => item.id === selectedPlanId.value)) {
          selectedPlanId.value = nextPlans[0]?.id ?? null
        }
      }
      return summary
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  async function loadWorkflow(id: string) {
    const op = begin('workflow')
    try {
      const value = await api.fetchLifeWorkflow(id)
      if (current(op)) { workflows.value = replace(workflows.value, value); selectedWorkflowId.value = id }
      return value
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  async function loadActivationReviews(accountId = selectedSourceId.value) {
    if (!accountId) return []
    const op = begin('reviews')
    try {
      const value = await api.fetchLifeActivationReviews(accountId)
      if (current(op)) activationReviews.value = value
      return value
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  function mutate<T>(key: string, action: () => Promise<T>, accept?: (value: T) => void): Promise<T> {
    const sequence = ++mutationSequence
    const previous = queues.get(key) ?? Promise.resolve()
    activeSaves.value += 1; mutationError.value = null
    const pending = previous.catch(() => undefined).then(action).then(value => {
      if (sequence <= mutationSequence) accept?.(value)
      return value
    }).catch(cause => { mutationError.value = errorText(cause); throw cause })
      .finally(() => { activeSaves.value = Math.max(0, activeSaves.value - 1); if (queues.get(key) === pending) queues.delete(key) })
    queues.set(key, pending); return pending
  }
  function remember(action: LifeActionResponseDto) {
    workflows.value = replace(workflows.value, action.workflow); selectedWorkflowId.value = action.workflow.id
  }
  function governed(key: string, action: () => Promise<LifeActionResponseDto>) {
    return mutate(key, action, remember)
  }
  function updateSource(value: LifeSourceDto) {
    if (overview.value) overview.value.accounts = replace(overview.value.accounts, value)
  }

  function createSource(input: Parameters<typeof api.createLifeSource>[0]) {
    return mutate(`source:${input.id}`, () => api.createLifeSource(input), value => {
      if (overview.value) overview.value.accounts = replace(overview.value.accounts, value)
      selectedSourceId.value = value.id
    })
  }
  function syncSource(input: SyncLifeSourceInput) {
    return governed(`source:${input.accountId}`, () => api.syncLifeSource(input))
  }
  function createConstraint(input: CreateLifeConstraintInput) {
    return mutate('constraint', () => api.createLifeConstraint(input), value => {
      constraints.value = replace(constraints.value, value)
    })
  }
  function createPlan(input: CreateLifePlanInput) {
    return mutate('plan', () => api.createLifePlan(input), value => {
      plans.value = replace(plans.value, value.plan); handoffs.value = merge(handoffs.value, value.handoffs)
      selectedPlanId.value = value.plan.id
    })
  }
  function verifyPlan(input: VerifyLifePlanInput) {
    return governed(`plan:${input.planRevisionId}`, () => api.verifyLifePlan(input))
  }
  function createHold(input: CreateLifeHoldInput) {
    return governed(`plan:${input.planRevisionId}`, () => api.createLifeHold(input))
  }
  function cancelHold(input: CancelLifeHoldInput) {
    return governed(`hold:${input.holdId}`, () => api.cancelLifeHold(input))
  }
  function cancelSubscription(input: CancelLifeSubscriptionInput) {
    return governed(`subscription:${input.subscriptionId}`, () => api.cancelLifeSubscription(input))
  }
  function reviewWorkflow(id: string, action: 'approve' | 'reject', reason = '') {
    return mutate(`workflow:${id}`, () => api.reviewLifeWorkflow(id, action, reason), value => {
      workflows.value = replace(workflows.value, value); selectedWorkflowId.value = value.id
    })
  }
  function updateHealth(accountId: string, health: Exclude<LifeAccountHealth, 'revoked'>, expectedVersion: number) {
    return mutate(`source:${accountId}`, () => api.updateLifeSourceHealth(accountId, health, expectedVersion), updateSource)
  }
  function activate(accountId: string, toMode: LifeSourceDto['mode'], limits: LifeActivationLimitsInput) {
    return mutate(`source:${accountId}`, () => api.activateLifeSource(accountId, toMode, limits), value => {
      updateSource(value.source); activationReviews.value = replace(activationReviews.value, value.review)
    })
  }
  function revoke(accountId: string, expectedVersion: number) {
    return mutate(`source:${accountId}`, () => api.revokeLifeSource(accountId, expectedVersion), updateSource)
  }
  async function selectSource(id: string) { selectedSourceId.value = id; await loadActivationReviews(id) }

  function reset() {
    generation += 1; overview.value = null; commitments.value = []; contacts.value = []; options.value = []
    subscriptions.value = []; constraints.value = []; plans.value = []; handoffs.value = []; holds.value = []
    cancellations.value = []; workflows.value = []; takeovers.value = []; activationReviews.value = []
    selectedSourceId.value = null; selectedPlanId.value = null; selectedWorkflowId.value = null
    activeLoads.value = 0; activeSaves.value = 0; mutationError.value = null
    resourceErrors.value = { dashboard: null, workflow: null, reviews: null }; queues.clear()
  }

  return { overview, commitments, contacts, options, subscriptions, constraints, plans, handoffs, holds,
    cancellations, workflows, takeovers, activationReviews, selectedSourceId, selectedPlanId, selectedWorkflowId,
    selectedSource, selectedPlan, selectedWorkflow, latestConstraint, planMaterialChanged, loading, saving, error,
    loadDashboard, loadWorkflow, loadActivationReviews, createSource, syncSource, createConstraint, createPlan,
    verifyPlan, createHold, cancelHold, cancelSubscription, reviewWorkflow, updateHealth, activate, revoke,
    selectSource, reset }
})

function replace<T extends { id: string }>(items: T[], value: T): T[] {
  const next = items.filter(item => item.id !== value.id); next.unshift(value); return next
}
function merge<T extends { id: string }>(items: T[], values: T[]): T[] {
  return values.reduce((result, value) => replace(result, value), items)
}
