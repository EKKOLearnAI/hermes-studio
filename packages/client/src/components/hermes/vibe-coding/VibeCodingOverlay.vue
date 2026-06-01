<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useVibeCodingStore, type VibeStepId } from '@/stores/hermes/vibe-coding'
import ApprovalModal from '@/components/hermes/chat/ApprovalModal.vue'
import PatchPreview from './PatchPreview.vue'
import SandboxTerminal from './SandboxTerminal.vue'

const vibeCodingStore = useVibeCodingStore()
const message = useMessage()

const statusLabel = computed(() => {
  switch (vibeCodingStore.status) {
    case 'awaiting_approval':
      return 'Waiting for L4 approval'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'complete':
      return 'Complete'
    case 'failed':
      return 'Blocked'
    case 'running':
      return 'Running'
    default:
      return 'Idle'
  }
})

const activeTitle = computed(() => vibeCodingStore.currentStep?.label || 'Build Mode')
const activeDetail = computed(() => vibeCodingStore.currentStep?.detail || 'Preparing the Aurora build lane.')
const runtimeHint = computed(() => {
  if (vibeCodingStore.status === 'failed') {
    return 'The pipeline stopped safely before any disk write. Review the terminal output, then retry or cancel.'
  }
  if (vibeCodingStore.status === 'awaiting_approval') {
    return 'Execution is paused at the L4 approval gate. Nothing will be written until you approve.'
  }
  if (vibeCodingStore.activeStep === 2) {
    return 'Hermes is drafting the feature spec and Vue component. The request has a timeout guard so the UI will not hang.'
  }
  if (vibeCodingStore.activeStep >= 5 && vibeCodingStore.activeStep <= 7) {
    return 'Generated output is being previewed, inspected, and scanned before approval.'
  }
  return 'Aurora is moving this build through the governed sandbox lane.'
})

function formatStepId(id: VibeStepId | 0 | number): string {
  return String(id).padStart(2, '0')
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function closePipeline() {
  vibeCodingStore.cancel()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !vibeCodingStore.isVisible) return
  event.preventDefault()
  closePipeline()
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})

watch(
  () => vibeCodingStore.deploymentNonce,
  () => {
    if (!vibeCodingStore.deploymentMessage) return
    message.success(vibeCodingStore.deploymentMessage)
  },
  { flush: 'sync' },
)
</script>

<template>
  <Transition name="vibe-overlay">
    <aside
      v-if="vibeCodingStore.isVisible"
      class="vibe-coding-overlay"
      aria-label="Vibe Coding build pipeline"
      aria-live="polite"
    >
      <header class="vibe-overlay-header">
        <div class="vibe-overlay-title-group">
          <p class="vibe-kicker">Aurora Build Mode</p>
          <h2>Vibe Coding Pipeline</h2>
        </div>

        <div class="vibe-overlay-actions">
          <span class="vibe-status" :class="`is-${vibeCodingStore.status}`">
            <span class="vibe-status-dot" aria-hidden="true"></span>
            {{ statusLabel }}
          </span>
          <span
            v-if="vibeCodingStore.isVisible"
            class="vibe-runtime-pill"
            aria-label="Pipeline elapsed time"
          >
            {{ formatDuration(vibeCodingStore.elapsedMs) }}
          </span>
          <button
            type="button"
            class="vibe-close-button"
            data-testid="vibe-pipeline-cancel"
            aria-label="Cancel Vibe Coding Pipeline"
            @click.stop.prevent="closePipeline"
          >
            Cancel
          </button>
        </div>
      </header>

      <div
        class="vibe-progress-strip"
        role="progressbar"
        :aria-valuenow="vibeCodingStore.progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span :style="{ width: `${vibeCodingStore.progressPercent}%` }"></span>
      </div>

      <div class="vibe-overlay-grid">
        <ol class="vibe-step-list">
          <li
            v-for="step in vibeCodingStore.steps"
            :key="step.id"
            class="vibe-step"
            :class="`is-${step.status}`"
          >
            <span class="vibe-step-index">{{ formatStepId(step.id) }}</span>
            <span class="vibe-step-copy">
              <strong>{{ step.label }}</strong>
              <small>{{ step.detail }}</small>
            </span>
            <span class="vibe-step-indicator" aria-hidden="true"></span>
          </li>
        </ol>

        <section class="vibe-main-panel">
          <div class="vibe-current-step">
            <p class="vibe-kicker">Step {{ formatStepId(vibeCodingStore.activeStep || 1) }}</p>
            <h3>{{ activeTitle }}</h3>
            <p>{{ activeDetail }}</p>
            <div class="vibe-runtime-row">
              <span>Step elapsed {{ formatDuration(vibeCodingStore.stepElapsedMs) }}</span>
              <strong>{{ runtimeHint }}</strong>
            </div>
          </div>

          <div class="vibe-intent-box">
            <span>Intent</span>
            <p>{{ vibeCodingStore.userInput }}</p>
          </div>

          <PatchPreview
            v-if="vibeCodingStore.showPatchPreview"
            :diff="vibeCodingStore.patchDiff"
            :spec="vibeCodingStore.spec"
            :ui-mock="vibeCodingStore.uiMock"
            :code="vibeCodingStore.generatedCode"
            :component-path="vibeCodingStore.componentPath"
          />

          <SandboxTerminal
            v-if="vibeCodingStore.showSandboxTerminal"
            :lines="vibeCodingStore.terminalLines"
          />

          <div
            v-if="vibeCodingStore.canRetry"
            class="vibe-recovery-card"
            role="status"
          >
            <div>
              <strong>Safe recovery available</strong>
              <p>Retry will restart the same Build intent from Step 01. The previous run did not write files.</p>
            </div>
            <NButton size="small" type="primary" @click="vibeCodingStore.retry">
              Retry
            </NButton>
          </div>

          <div
            v-if="vibeCodingStore.approvalPending"
            class="vibe-approval-hold"
          >
            <span class="vibe-approval-icon" aria-hidden="true">!</span>
            <div>
              <strong>L4 approval required</strong>
              <p>The pipeline is halted at Step 08 until the user explicitly approves or rejects execution.</p>
            </div>
          </div>
        </section>
      </div>

      <ApprovalModal
        :approval="vibeCodingStore.activeApproval"
        @approve="vibeCodingStore.approve"
        @reject="vibeCodingStore.reject"
      />
    </aside>
  </Transition>
</template>

<style scoped lang="scss">
.vibe-coding-overlay {
  position: absolute;
  top: 70px;
  right: 24px;
  bottom: 24px;
  z-index: 1800;
  display: flex;
  width: min(780px, calc(100% - 48px));
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--aurora-glass-border, rgba(255, 255, 255, 0.62));
  border-radius: 18px;
  color: var(--aurora-text, #172033);
  background: var(--aurora-glass-bg, rgba(255, 255, 255, 0.72));
  box-shadow: var(--aurora-glass-shadow, 0 22px 70px rgba(66, 84, 117, 0.22));
  backdrop-filter: blur(26px);
}

.vibe-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 60px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid rgba(92, 113, 148, 0.14);
}

.vibe-overlay-title-group {
  min-width: 0;
}

.vibe-kicker {
  margin: 0 0 4px;
  color: rgba(21, 32, 51, 0.54);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0;
  line-height: 1.1;
  text-transform: uppercase;
}

.vibe-overlay-header h2,
.vibe-current-step h3 {
  margin: 0;
  color: #142033;
  font-weight: 850;
  letter-spacing: 0;
}

.vibe-overlay-header h2 {
  overflow: hidden;
  font-size: 16px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vibe-overlay-actions {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
}

.vibe-progress-strip {
  height: 3px;
  overflow: hidden;
  background: rgba(76, 98, 131, 0.08);
}

.vibe-progress-strip span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #7c6dff, #2bd1ff, #34d399);
  box-shadow: 0 0 18px rgba(43, 209, 255, 0.32);
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.vibe-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 190px;
  padding: 6px 9px;
  border: 1px solid rgba(43, 209, 255, 0.22);
  border-radius: 999px;
  color: #117da0;
  background: rgba(43, 209, 255, 0.09);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.1;
  white-space: nowrap;
}

.vibe-runtime-pill {
  display: inline-flex;
  min-width: 48px;
  justify-content: center;
  padding: 6px 8px;
  border: 1px solid rgba(97, 80, 220, 0.16);
  border-radius: 999px;
  color: rgba(97, 80, 220, 0.78);
  background: rgba(255, 255, 255, 0.44);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
}

.vibe-status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 10px currentColor;
}

.vibe-status.is-awaiting_approval,
.vibe-status.is-rejected,
.vibe-status.is-failed {
  border-color: rgba(248, 113, 113, 0.28);
  color: #b33838;
  background: rgba(248, 113, 113, 0.1);
}

.vibe-status.is-approved,
.vibe-status.is-complete {
  border-color: rgba(52, 211, 153, 0.24);
  color: #16724b;
  background: rgba(52, 211, 153, 0.1);
}

.vibe-close-button {
  flex: 0 0 auto;
  position: relative;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 11px;
  border: 1px solid rgba(76, 98, 131, 0.16);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.68);
  background: rgba(255, 255, 255, 0.48);
  box-shadow:
    0 8px 20px rgba(66, 84, 117, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.62);
  cursor: pointer;
  font-size: 12px;
  font-weight: 750;
  line-height: 1;
  pointer-events: auto;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
}

.vibe-close-button:hover,
.vibe-close-button:focus-visible {
  border-color: rgba(248, 113, 113, 0.34);
  color: #9c2f2f;
  background: rgba(255, 255, 255, 0.68);
  outline: none;
  transform: translateY(-1px);
}

.vibe-overlay-grid {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  padding: 12px;
}

.vibe-step-list {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vibe-step {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 12px;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 8px 9px;
  border: 1px solid rgba(76, 98, 131, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.48);
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    color 0.16s ease;
}

.vibe-step-index {
  color: rgba(21, 32, 51, 0.44);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  font-weight: 800;
}

.vibe-step-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.vibe-step-copy strong,
.vibe-step-copy small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vibe-step-copy strong {
  color: rgba(21, 32, 51, 0.78);
  font-size: 12px;
  line-height: 1.15;
}

.vibe-step-copy small {
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  line-height: 1.25;
}

.vibe-step-indicator {
  width: 9px;
  height: 9px;
  border: 1px solid rgba(76, 98, 131, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.58);
}

.vibe-step.is-active {
  border-color: rgba(43, 209, 255, 0.34);
  background: rgba(43, 209, 255, 0.1);
}

.vibe-step.is-active .vibe-step-indicator {
  border-color: #2bd1ff;
  background: #2bd1ff;
  box-shadow: 0 0 14px rgba(43, 209, 255, 0.72);
}

.vibe-step.is-complete .vibe-step-indicator {
  border-color: #34d399;
  background: #34d399;
}

.vibe-step.is-blocked {
  border-color: rgba(248, 113, 113, 0.34);
  background: rgba(248, 113, 113, 0.1);
}

.vibe-step.is-blocked .vibe-step-indicator {
  border-color: #f87171;
  background: #f87171;
}

.vibe-main-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding-right: 2px;
}

.vibe-current-step {
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.5);
}

.vibe-current-step h3 {
  font-size: 18px;
  line-height: 1.22;
}

.vibe-current-step > p:not(.vibe-kicker) {
  margin: 7px 0 0;
  color: rgba(21, 32, 51, 0.6);
  font-size: 12px;
  line-height: 1.45;
}

.vibe-runtime-row {
  display: grid;
  gap: 4px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(76, 98, 131, 0.1);
}

.vibe-runtime-row span {
  color: rgba(97, 80, 220, 0.66);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 10px;
  font-weight: 850;
  line-height: 1.2;
}

.vibe-runtime-row strong {
  color: rgba(21, 32, 51, 0.72);
  font-size: 12px;
  font-weight: 750;
  line-height: 1.45;
}

.vibe-intent-box {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(76, 98, 131, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.46);
}

.vibe-intent-box span {
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.1;
  text-transform: uppercase;
}

.vibe-intent-box p {
  margin: 0;
  color: rgba(21, 32, 51, 0.72);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.vibe-approval-hold {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 12px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 8px;
  color: #8d2b2b;
  background: rgba(248, 113, 113, 0.1);
}

.vibe-approval-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: #fff7f7;
  background: #d34545;
  font-size: 16px;
  font-weight: 900;
}

.vibe-approval-hold strong {
  display: block;
  color: #8d2b2b;
  font-size: 13px;
  line-height: 1.2;
}

.vibe-approval-hold p {
  margin: 5px 0 0;
  color: rgba(141, 43, 43, 0.74);
  font-size: 12px;
  line-height: 1.45;
}

.vibe-recovery-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(245, 158, 11, 0.28);
  border-radius: 10px;
  background:
    linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(255, 255, 255, 0.46)),
    rgba(255, 255, 255, 0.42);
}

.vibe-recovery-card strong {
  display: block;
  color: rgba(127, 75, 0, 0.92);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.2;
}

.vibe-recovery-card p {
  margin: 5px 0 0;
  color: rgba(127, 75, 0, 0.72);
  font-size: 12px;
  line-height: 1.45;
}

.vibe-overlay-enter-active,
.vibe-overlay-leave-active {
  transition: all var(--aurora-ease, 0.3s cubic-bezier(0.2, 0, 0, 1));
}

.vibe-overlay-enter-from,
.vibe-overlay-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

:global(.dark) .vibe-coding-overlay {
  border-color: rgba(255, 255, 255, 0.12);
  color: #edf3ff;
  background:
    linear-gradient(135deg, rgba(29, 35, 48, 0.9), rgba(17, 21, 31, 0.78)),
    rgba(18, 22, 32, 0.78);
  box-shadow:
    0 22px 70px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .vibe-overlay-header {
  border-bottom-color: rgba(255, 255, 255, 0.09);
}

:global(.dark) .vibe-progress-strip {
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .vibe-kicker,
:global(.dark) .vibe-current-step > p:not(.vibe-kicker),
:global(.dark) .vibe-runtime-row strong,
:global(.dark) .vibe-intent-box span,
:global(.dark) .vibe-intent-box p {
  color: rgba(237, 243, 255, 0.62);
}

:global(.dark) .vibe-runtime-pill,
:global(.dark) .vibe-runtime-row span {
  border-color: rgba(139, 132, 255, 0.18);
  color: rgba(177, 171, 255, 0.78);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .vibe-close-button {
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(237, 243, 255, 0.72);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .vibe-close-button:hover,
:global(.dark) .vibe-close-button:focus-visible {
  border-color: rgba(248, 113, 113, 0.32);
  color: #fecaca;
  background: rgba(248, 113, 113, 0.12);
}

:global(.dark) .vibe-overlay-header h2,
:global(.dark) .vibe-current-step h3,
:global(.dark) .vibe-step-copy strong {
  color: #edf3ff;
}

:global(.dark) .vibe-step,
:global(.dark) .vibe-current-step,
:global(.dark) .vibe-intent-box,
:global(.dark) .vibe-recovery-card {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .vibe-step-index,
:global(.dark) .vibe-step-copy small {
  color: rgba(237, 243, 255, 0.48);
}

@media (max-width: 900px) {
  .vibe-coding-overlay {
    top: 58px;
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }

  .vibe-overlay-grid {
    grid-template-columns: 1fr;
  }

  .vibe-step-list {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(170px, 1fr);
    overflow-x: auto;
    overflow-y: hidden;
  }
}

@media (max-width: 560px) {
  .vibe-coding-overlay {
    border-radius: 14px;
  }

  .vibe-overlay-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  .vibe-overlay-actions {
    width: 100%;
    justify-content: space-between;
  }

  .vibe-status {
    max-width: calc(100% - 76px);
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
