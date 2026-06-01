import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useChatStore, type PendingApproval } from './chat'
import {
  applyVibeWidget,
  buildVibeWidget,
  type VibeBuildResponse,
  type VibeSecurityReportItem,
} from '@/api/aurora/vibe-coding'

export type VibeStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
export type VibeStepStatus = 'pending' | 'active' | 'complete' | 'blocked'
export type VibePipelineStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'complete'
  | 'failed'

export interface VibeStep {
  id: VibeStepId
  label: string
  detail: string
  status: VibeStepStatus
}

export interface SandboxLine {
  id: string
  source: 'test' | 'security' | 'system'
  text: string
  tone: 'muted' | 'info' | 'success' | 'warning' | 'danger'
}

export interface VibeRuntimeFixIntent {
  id: string
  widgetName: string
  componentPath?: string
  errorMessage: string
  stack?: string
  queuedAt: string
  prompt: string
}

export interface VibeLastStableWidget {
  buildId: string
  widgetName: string
  componentPath: string
  spec: string
  appliedAt: string
}

const STEP_META: Array<Omit<VibeStep, 'status'>> = [
  { id: 1, label: 'User Input', detail: 'Capture the Build intent from the OmniBar.' },
  { id: 2, label: 'Spec Draft', detail: 'Generate a real feature spec through the Hermes LLM provider.' },
  { id: 3, label: 'UI Model', detail: 'Extract the Aurora glass layout plan from the LLM response.' },
  { id: 4, label: 'Code Plan', detail: 'Receive a Vue 3 generated component payload.' },
  { id: 5, label: 'Patch Preview', detail: 'Review the generated component before any file write.' },
  { id: 6, label: 'Test Sandbox', detail: 'Inspect generated artifact metadata in an isolated lane.' },
  { id: 7, label: 'Security Scan', detail: 'Enforce blocked patterns before approval.' },
  { id: 8, label: 'User Approval', detail: 'No disk write happens until the user approves.' },
  { id: 9, label: 'Apply Result', detail: 'Write only to packages/client/src/components/generated.' },
  { id: 10, label: 'Complete', detail: 'Log the audit and return to Aurora.' },
]

const GENERATED_COMPONENT_PATH_PREFIX = 'packages/client/src/components/generated/'
const VIBE_BUILD_TIMEOUT_MS = 90_000

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeIntent(input: string): string {
  return input.replace(/\s+/g, ' ').trim() || 'Implement the requested Aurora build intent.'
}

function securityTone(item: VibeSecurityReportItem): SandboxLine['tone'] {
  return item.severity === 'danger' ? 'danger' : 'warning'
}

function normalizeComponentPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSafeGeneratedBuild(result: Pick<VibeBuildResponse, 'widgetName' | 'componentPath'>): boolean {
  const normalizedPath = normalizeComponentPath(result.componentPath)
  const expectedPath = `${GENERATED_COMPONENT_PATH_PREFIX}${result.widgetName}.vue`
  return (
    /^[A-Z][A-Za-z0-9]*$/.test(result.widgetName) &&
    normalizedPath === expectedPath &&
    !normalizedPath.split('/').includes('..')
  )
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      onTimeout?.()
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s. Retry or cancel safely.`))
    }, timeoutMs)

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => globalThis.clearTimeout(timeout))
  })
}

export const useVibeCodingStore = defineStore('vibe-coding', () => {
  const isVisible = ref(false)
  const status = ref<VibePipelineStatus>('idle')
  const activeStep = ref<VibeStepId | 0>(0)
  const completedSteps = ref<Set<VibeStepId>>(new Set())
  const blockedStep = ref<VibeStepId | null>(null)
  const userInput = ref('')
  const spec = ref('')
  const uiMock = ref('')
  const generatedCode = ref('')
  const widgetName = ref('')
  const componentPath = ref('')
  const buildId = ref('')
  const patchDiff = ref('')
  const terminalLines = ref<SandboxLine[]>([])
  const securityReport = ref<VibeSecurityReportItem[]>([])
  const approvalRequestedAt = ref(0)
  const deploymentMessage = ref('')
  const deploymentNonce = ref(0)
  const selfHealingFixQueue = ref<VibeRuntimeFixIntent[]>([])
  const lastStableWidget = ref<VibeLastStableWidget | null>(null)
  const startedAt = ref(0)
  const stepStartedAt = ref(0)
  const elapsedMs = ref(0)
  const stepElapsedMs = ref(0)

  let runToken = 0
  let latestBuild: VibeBuildResponse | null = null
  let elapsedTicker: ReturnType<typeof globalThis.setInterval> | null = null
  let activeAbortController: AbortController | null = null

  const steps = computed<VibeStep[]>(() =>
    STEP_META.map((step) => ({
      ...step,
      status: blockedStep.value === step.id
        ? 'blocked'
        : completedSteps.value.has(step.id)
          ? 'complete'
          : activeStep.value === step.id
            ? 'active'
            : 'pending',
    })),
  )

  const currentStep = computed(() =>
    steps.value.find((step) => step.id === activeStep.value) || null,
  )

  const showPatchPreview = computed(() =>
    isVisible.value && activeStep.value >= 5 && generatedCode.value.length > 0,
  )

  const showSandboxTerminal = computed(() =>
    isVisible.value && (activeStep.value >= 6 || terminalLines.value.length > 0),
  )

  const progressPercent = computed(() => {
    if (!isVisible.value) return 0
    const activeBonus = activeStep.value > 0 && !completedSteps.value.has(activeStep.value as VibeStepId) ? 0.45 : 0
    return Math.min(100, Math.round(((completedSteps.value.size + activeBonus) / STEP_META.length) * 100))
  })

  const approvalPending = computed(() =>
    status.value === 'awaiting_approval' && activeStep.value === 8,
  )

  const canRetry = computed(() =>
    isVisible.value && status.value === 'failed' && userInput.value.trim().length > 0,
  )

  const activeApproval = computed<PendingApproval | null>(() => {
    if (!approvalPending.value) return null
    return {
      sessionId: 'vibe-build',
      approvalId: `vibe-build-${approvalRequestedAt.value}`,
      command: `write ${componentPath.value || 'packages/client/src/components/generated/*.vue'}`,
      description: 'Aurora Build mode generated a Vue component. Disk write is locked until explicit approval.',
      choices: ['once', 'deny'],
      allowPermanent: false,
      requestedAt: approvalRequestedAt.value,
      tool: 'vibe-apply',
      securityLevel: 'L4_Locked',
    }
  })

  function ensureActive(token: number): boolean {
    return runToken === token && isVisible.value
  }

  function tickElapsed() {
    const now = Date.now()
    elapsedMs.value = startedAt.value > 0 ? now - startedAt.value : 0
    stepElapsedMs.value = stepStartedAt.value > 0 ? now - stepStartedAt.value : 0
  }

  function startElapsedClock() {
    startedAt.value = Date.now()
    stepStartedAt.value = startedAt.value
    tickElapsed()
    if (elapsedTicker) globalThis.clearInterval(elapsedTicker)
    elapsedTicker = globalThis.setInterval(tickElapsed, 1000)
  }

  function stopElapsedClock() {
    if (elapsedTicker) {
      globalThis.clearInterval(elapsedTicker)
      elapsedTicker = null
    }
    tickElapsed()
  }

  function abortActiveRequest() {
    if (!activeAbortController) return
    activeAbortController.abort()
    activeAbortController = null
  }

  function setActiveStep(step: VibeStepId) {
    activeStep.value = step
    stepStartedAt.value = Date.now()
    stepElapsedMs.value = 0
  }

  function completeStep(step: VibeStepId) {
    const next = new Set(completedSteps.value)
    next.add(step)
    completedSteps.value = next
  }

  function blockStep(step: VibeStepId) {
    blockedStep.value = step
    setActiveStep(step)
  }

  function addTerminalLine(
    source: SandboxLine['source'],
    text: string,
    tone: SandboxLine['tone'] = 'info',
  ) {
    terminalLines.value.push({
      id: makeId(source),
      source,
      text,
      tone,
    })
  }

  function resetState() {
    stopElapsedClock()
    abortActiveRequest()
    isVisible.value = false
    status.value = 'idle'
    activeStep.value = 0
    completedSteps.value = new Set()
    blockedStep.value = null
    userInput.value = ''
    spec.value = ''
    uiMock.value = ''
    generatedCode.value = ''
    widgetName.value = ''
    componentPath.value = ''
    buildId.value = ''
    patchDiff.value = ''
    terminalLines.value = []
    securityReport.value = []
    approvalRequestedAt.value = 0
    startedAt.value = 0
    stepStartedAt.value = 0
    elapsedMs.value = 0
    stepElapsedMs.value = 0
    latestBuild = null
  }

  function ingestBuild(result: VibeBuildResponse) {
    latestBuild = result
    buildId.value = result.buildId
    widgetName.value = result.widgetName
    componentPath.value = result.componentPath
    spec.value = result.spec
    uiMock.value = result.uiMock
    generatedCode.value = result.code
    patchDiff.value = result.patchDiff
    securityReport.value = result.securityReport || []
  }

  async function runPipeline(token: number) {
    try {
      setActiveStep(1)
      completeStep(1)

      setActiveStep(2)
      addTerminalLine('system', 'Calling /api/aurora/vibe-build with the Build intent.', 'info')
      addTerminalLine('system', `Timeout guard armed at ${Math.round(VIBE_BUILD_TIMEOUT_MS / 1000)}s. The UI will stay recoverable.`, 'muted')
      activeAbortController = new AbortController()
      const build = await withTimeout(
        buildVibeWidget(userInput.value, activeAbortController.signal),
        VIBE_BUILD_TIMEOUT_MS,
        'Aurora vibe build',
        () => activeAbortController?.abort(),
      )
      activeAbortController = null
      if (!ensureActive(token)) return

      ingestBuild(build)
      completeStep(2)

      setActiveStep(3)
      addTerminalLine('system', `UI mock received: ${build.uiMock}`, 'info')
      completeStep(3)

      setActiveStep(4)
      addTerminalLine('system', `Generated ${build.widgetName}.vue from ${build.runtime?.model || 'Hermes LLM'}.`, 'success')
      completeStep(4)

      setActiveStep(5)
      completeStep(5)

      setActiveStep(6)
      addTerminalLine('test', `Component target: ${build.componentPath}`, 'muted')
      addTerminalLine('test', 'SFC structure accepted for preview.', 'success')
      completeStep(6)

      setActiveStep(7)
      addTerminalLine('security', '$ aurora security scan --strict generated-code.vue', 'muted')
      if (!isSafeGeneratedBuild(build)) {
        blockStep(7)
        status.value = 'failed'
        addTerminalLine('security', `Unsafe generated component path blocked: ${build.componentPath}`, 'danger')
        addTerminalLine('system', 'Pipeline blocked before approval. No disk write was performed.', 'danger')
        return
      }
      if (build.securityReport.length > 0) {
        for (const item of build.securityReport) {
          addTerminalLine('security', `${item.pattern}: ${item.message}`, securityTone(item))
        }
        blockStep(7)
        status.value = 'failed'
        addTerminalLine('system', 'Pipeline blocked before approval. No disk write was performed.', 'danger')
        return
      }
      addTerminalLine('security', 'No blocked patterns found. Security report is empty.', 'success')
      completeStep(7)

      if (!ensureActive(token)) return
      setActiveStep(8)
      status.value = 'awaiting_approval'
      approvalRequestedAt.value = Date.now()
    } catch (err: any) {
      activeAbortController = null
      if (!ensureActive(token)) return
      if (err?.name === 'AbortError') return
      status.value = 'failed'
      blockStep((activeStep.value || 2) as VibeStepId)
      addTerminalLine('system', err?.message || 'Aurora vibe build failed.', 'danger')
      addTerminalLine('system', 'No disk write was performed. Use Retry to restart this intent safely.', 'warning')
    }
  }

  async function completeAfterApproval(token: number) {
    if (!latestBuild || !ensureActive(token)) return

    setActiveStep(9)
    if (!isSafeGeneratedBuild(latestBuild)) {
      status.value = 'failed'
      blockStep(9)
      addTerminalLine('system', 'Aurora vibe apply refused an unsafe generated component path.', 'danger')
      return
    }
    addTerminalLine('system', 'Calling /api/aurora/vibe-apply for safe isolated write.', 'info')
    try {
      activeAbortController = new AbortController()
      const applied = await applyVibeWidget({
        buildId: buildId.value,
        widgetName: widgetName.value,
        code: generatedCode.value,
        spec: spec.value,
      }, activeAbortController.signal)
      activeAbortController = null
      if (!ensureActive(token)) return
      completeStep(9)
      addTerminalLine('system', `Widget deployed successfully to ${applied.path}.`, 'success')
      if (applied.manifestPath) {
        addTerminalLine('security', `Permission manifest sealed at ${applied.manifestPath}.`, 'success')
      }
      addTerminalLine('system', `Audit logged at ${applied.audit.appliedAt}.`, 'success')
      lastStableWidget.value = {
        buildId: applied.audit.buildId || buildId.value,
        widgetName: applied.audit.widgetName || widgetName.value,
        componentPath: applied.path,
        spec: spec.value,
        appliedAt: applied.audit.appliedAt,
      }

      setActiveStep(10)
      completeStep(10)
      status.value = 'complete'
      stopElapsedClock()
      deploymentMessage.value = 'Widget deployed successfully to /generated.'
      deploymentNonce.value += 1
      resetState()
    } catch (err: any) {
      activeAbortController = null
      if (!ensureActive(token)) return
      if (err?.name === 'AbortError') return
      status.value = 'failed'
      blockStep(9)
      addTerminalLine('system', err?.message || 'Aurora vibe apply failed. No widget was deployed.', 'danger')
    }
  }

  function start(input: string) {
    runToken += 1
    const token = runToken
    resetState()
    isVisible.value = true
    status.value = 'running'
    activeStep.value = 1
    userInput.value = normalizeIntent(input)
    startElapsedClock()
    void runPipeline(token)
  }

  function approve() {
    if (!approvalPending.value) return
    runToken += 1
    const token = runToken
    status.value = 'approved'
    completeStep(8)
    addTerminalLine('system', 'User approved L4 write to the generated components folder.', 'success')
    void completeAfterApproval(token)
  }

  function reject() {
    if (!approvalPending.value) return
    const rejectedApproval = activeApproval.value
    runToken += 1
    status.value = 'rejected'
    blockedStep.value = 8
    addTerminalLine('system', 'System: Tool execution rejected by user.', 'danger')
    useChatStore().injectSystemMessage('System: Tool execution rejected by user.', {
      commandAction: 'vibe.build.rejected',
      commandData: {
        command: rejectedApproval?.command,
        step: 8,
        tool: rejectedApproval?.tool,
      },
    })
    resetState()
  }

  function retry() {
    if (!canRetry.value) return
    start(userInput.value)
  }

  function cancel() {
    runToken += 1
    abortActiveRequest()
    resetState()
  }

  function queueRuntimeFix(input: {
    widgetName: string
    componentPath?: string
    errorMessage: string
    stack?: string
  }) {
    const prompt = [
      `Fix generated widget ${input.widgetName}.`,
      'The generated component threw this runtime error. Fix the code and re-submit.',
      `Error: ${input.errorMessage}`,
      input.stack ? `Stack: ${input.stack.slice(0, 1800)}` : '',
    ].filter(Boolean).join('\n')

    selfHealingFixQueue.value = [
      {
        id: makeId('runtime-fix'),
        widgetName: input.widgetName,
        componentPath: input.componentPath,
        errorMessage: input.errorMessage,
        stack: input.stack,
        queuedAt: new Date().toISOString(),
        prompt,
      },
      ...selfHealingFixQueue.value,
    ].slice(0, 12)
  }

  return {
    isVisible,
    status,
    activeStep,
    steps,
    currentStep,
    userInput,
    spec,
    uiMock,
    generatedCode,
    widgetName,
    componentPath,
    buildId,
    patchDiff,
    terminalLines,
    securityReport,
    showPatchPreview,
    showSandboxTerminal,
    progressPercent,
    approvalPending,
    activeApproval,
    deploymentMessage,
    deploymentNonce,
    selfHealingFixQueue,
    lastStableWidget,
    elapsedMs,
    stepElapsedMs,
    canRetry,
    start,
    approve,
    reject,
    retry,
    cancel,
    queueRuntimeFix,
  }
})
