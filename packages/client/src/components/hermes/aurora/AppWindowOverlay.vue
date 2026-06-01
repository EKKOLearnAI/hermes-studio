<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuroraAppBrief } from '@/composables/useAuroraAppBrief'
import { getAuroraAppWindowDefinition } from '@/services/hermes/aurora/app-window-registry'
import { useAppStore } from '@/stores/hermes/app'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'

const appWindowStore = useAuroraAppWindowStore()
const appStore = useAppStore()
const commanderStore = useAuroraCommanderStore()
const router = useRouter()
const {
  activeBrief,
  briefLoading,
  briefError,
  briefUpdatedAt,
  formatBriefUpdatedAt,
  loadAppBrief,
} = useAuroraAppBrief()

const activeComponent = computed(() => {
  const kind = appWindowStore.activeApp?.kind
  return kind ? getAuroraAppWindowDefinition(kind).component : null
})
const payloadAwareAppKinds = new Set(['mirofish', 'mirofish-arena', 'mirofish-graph', 'browser', 'tradingview', 'video-studio'])
const cosmicAppKinds = new Set(['mirofish', 'mirofish-arena', 'mirofish-graph', 'browser', 'tradingview'])
const mergedMiroFishAppKinds = new Set(['mirofish'])
const activeComponentProps = computed(() => {
  const kind = appWindowStore.activeApp?.kind
  if (!kind || !payloadAwareAppKinds.has(kind) || !appWindowStore.activePayload) return {}
  return appWindowStore.activePayload
})
const isCosmicApp = computed(() => {
  const kind = appWindowStore.activeApp?.kind
  return !!kind && cosmicAppKinds.has(kind)
})
const isMergedMiroFishApp = computed(() => {
  const kind = appWindowStore.activeApp?.kind
  return !!kind && mergedMiroFishAppKinds.has(kind)
})
const mergedMiroFishDenoiseStyle = computed(() => isMergedMiroFishApp.value
  ? {
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    }
  : undefined)

function closeApp() {
  appWindowStore.closeApp()
  commanderStore.clear()
  appStore.setAdvancedConsoleOpen(false)
  void router.push('/aurora')
}
</script>

<template>
  <Transition name="app-window">
    <section
      v-if="appWindowStore.activeApp && activeComponent"
      class="app-window-overlay"
      :class="{ 'is-cosmic-app': isCosmicApp, 'is-merged-mirofish-app': isMergedMiroFishApp }"
      :style="mergedMiroFishDenoiseStyle"
      aria-label="Aurora App Window"
    >
      <div class="app-window-frame" :style="mergedMiroFishDenoiseStyle">
        <header class="app-window-titlebar">
          <div class="traffic-lights" aria-label="Window controls">
            <button
              class="traffic close"
              type="button"
              aria-label="Close App"
              title="Close App"
              @click="closeApp"
            ></button>
            <button
              class="traffic minimize"
              type="button"
              aria-label="Minimize App"
              title="Minimize App"
              @click="closeApp"
            ></button>
            <button
              class="traffic maximize"
              type="button"
              aria-label="Maximize App"
              title="Maximize App"
            ></button>
          </div>

          <div v-if="!isMergedMiroFishApp" class="app-window-title">
            <strong>{{ appWindowStore.activeApp.title }}</strong>
            <span>{{ appWindowStore.activeApp.subtitle }}</span>
          </div>
          <div v-else class="app-window-title app-window-title-immersive" aria-hidden="true"></div>

          <button v-if="!isMergedMiroFishApp" class="close-app-button" type="button" @click="closeApp">
            Close App
          </button>
        </header>

        <main class="app-window-content" :class="{ 'has-aurora-brief': activeBrief }" :style="mergedMiroFishDenoiseStyle">
          <section v-if="activeBrief" class="app-window-brief" aria-label="Aurora App Brief">
            <div>
              <p>{{ activeBrief.eyebrow }}</p>
              <h2>{{ activeBrief.title }}</h2>
              <span>{{ activeBrief.summary }}</span>
              <small v-if="briefLoading">Refreshing live state...</small>
              <small v-else>Updated {{ formatBriefUpdatedAt(briefUpdatedAt) }}</small>
              <small v-if="!briefLoading && briefError" class="brief-error">{{ briefError }}</small>
            </div>
            <div class="app-window-brief-side">
              <button
                class="app-window-brief-refresh"
                type="button"
                :disabled="briefLoading"
                @click="loadAppBrief(undefined, 'manual')"
              >
                {{ briefLoading ? 'Refreshing' : 'Refresh' }}
              </button>
              <small class="app-window-brief-auto">Auto refresh · 90s</small>
              <div class="app-window-brief-metrics">
                <article v-for="metric in activeBrief.metrics" :key="metric.label">
                  <span>{{ metric.label }}</span>
                  <strong>{{ metric.value }}</strong>
                </article>
              </div>
            </div>
          </section>
          <Suspense>
            <component :is="activeComponent" v-bind="activeComponentProps" />
            <template #fallback>
              <div class="app-window-loading">Loading app...</div>
            </template>
          </Suspense>
        </main>
      </div>
    </section>
  </Transition>
</template>

<style scoped lang="scss">
.app-window-overlay {
  --aurora-glass-bg: rgba(255, 255, 255, 0.08);
  --aurora-glass-bg-strong: rgba(255, 255, 255, 0.12);
  --aurora-glass-border: rgba(255, 255, 255, 0.16);
  --aurora-glass-shadow: 0 24px 80px rgba(2, 6, 23, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  --aurora-glass-blur: blur(24px);
  --aurora-text: rgba(248, 250, 252, 0.94);
  --aurora-muted: rgba(203, 213, 225, 0.66);
  --aurora-accent: #818cf8;

  position: fixed;
  inset: 0;
  z-index: 4200;
  display: flex;
  width: 100vw;
  min-height: 100vh;
  height: 100vh;
  padding: 18px;
  background:
    radial-gradient(900px 420px at 10% 12%, rgba(169, 197, 255, 0.38), transparent 64%),
    radial-gradient(760px 460px at 88% 8%, rgba(216, 181, 255, 0.34), transparent 62%),
    linear-gradient(135deg, rgba(246, 251, 255, 0.72), rgba(245, 240, 255, 0.66));
  backdrop-filter: blur(22px);
}

.app-window-frame {
  display: grid;
  grid-template-rows: 54px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 24px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.46)),
    rgba(255, 255, 255, 0.58);
  box-shadow:
    0 28px 90px rgba(52, 67, 104, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.74);
  backdrop-filter: blur(24px);
}

@supports (height: 100dvh) {
  .app-window-overlay {
    min-height: 100dvh;
    height: 100dvh;
  }
}

.app-window-titlebar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 0 14px;
  border-bottom: 1px solid rgba(72, 91, 126, 0.13);
  background: rgba(255, 255, 255, 0.48);
}

.traffic-lights {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.traffic {
  width: 13px;
  height: 13px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}

.traffic.close {
  background: #ff5f57;
}

.traffic.minimize {
  background: #ffbd2e;
}

.traffic.maximize {
  background: #28c840;
  cursor: default;
}

.app-window-title {
  display: grid;
  min-width: 0;
  justify-items: center;
  line-height: 1.15;
}

.app-window-title strong,
.app-window-title span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-window-title strong {
  color: rgba(21, 32, 51, 0.88);
  font-size: 14px;
  font-weight: 900;
}

.app-window-title span {
  margin-top: 3px;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 750;
}

.close-app-button {
  min-height: 32px;
  padding: 0 13px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
  cursor: pointer;
  font-size: 12px;
  font-weight: 850;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.close-app-button:hover {
  border-color: rgba(121, 99, 255, 0.34);
  background: rgba(255, 255, 255, 0.76);
  transform: translateY(-1px);
}

.app-window-content {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 0;
  background:
    radial-gradient(640px 260px at 22% 8%, rgba(255, 255, 255, 0.26), transparent 68%),
    rgba(247, 250, 255, 0.36);
}

.app-window-overlay.is-cosmic-app {
  background:
    radial-gradient(900px 420px at 12% 10%, rgba(56, 189, 248, 0.24), transparent 62%),
    radial-gradient(780px 480px at 86% 8%, rgba(168, 85, 247, 0.26), transparent 60%),
    radial-gradient(780px 420px at 68% 92%, rgba(14, 165, 233, 0.14), transparent 58%),
    linear-gradient(135deg, rgba(15, 23, 42, 0.94), rgba(30, 27, 75, 0.9));
}

.app-window-overlay.is-cosmic-app .app-window-frame {
  border-color: rgba(255, 255, 255, 0.13);
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.52), rgba(30, 27, 75, 0.38)),
    rgba(2, 6, 23, 0.42);
  box-shadow:
    0 30px 120px rgba(2, 6, 23, 0.46),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.app-window-overlay.is-cosmic-app .app-window-titlebar {
  border-bottom-color: rgba(255, 255, 255, 0.1);
  background: rgba(15, 23, 42, 0.38);
}

.app-window-overlay.is-cosmic-app .app-window-title strong {
  color: rgba(248, 250, 252, 0.94);
}

.app-window-overlay.is-cosmic-app .app-window-title span {
  color: rgba(191, 219, 254, 0.62);
}

.app-window-overlay.is-cosmic-app .close-app-button {
  border-color: rgba(255, 255, 255, 0.13);
  color: rgba(226, 232, 240, 0.92);
  background: rgba(255, 255, 255, 0.08);
}

.app-window-overlay.is-cosmic-app .close-app-button:hover {
  border-color: rgba(129, 140, 248, 0.36);
  background: rgba(255, 255, 255, 0.14);
}

.app-window-overlay.is-cosmic-app .app-window-content {
  background:
    radial-gradient(640px 280px at 22% 8%, rgba(56, 189, 248, 0.12), transparent 70%),
    radial-gradient(720px 320px at 80% 96%, rgba(168, 85, 247, 0.12), transparent 72%),
    rgba(2, 6, 23, 0.24);
}

.app-window-overlay.is-cosmic-app .app-window-loading {
  color: rgba(226, 232, 240, 0.72);
}

.app-window-overlay.is-merged-mirofish-app {
  padding: 0;
  background:
    radial-gradient(900px 520px at 12% 8%, rgba(56, 189, 248, 0.16), transparent 62%),
    radial-gradient(880px 560px at 88% 12%, rgba(129, 140, 248, 0.18), transparent 62%),
    radial-gradient(980px 620px at 72% 96%, rgba(74, 21, 75, 0.34), transparent 68%),
    conic-gradient(from 225deg at 50% 48%, #0b0b1a 0deg, #2b0f4c 106deg, #4a154b 168deg, #0f172a 258deg, #020617 360deg);
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  isolation: isolate;
}

.app-window-overlay.is-merged-mirofish-app .app-window-frame {
  display: block;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.app-window-overlay.is-merged-mirofish-app .app-window-titlebar {
  position: fixed;
  z-index: 30;
  top: 16px;
  left: 18px;
  display: inline-grid;
  grid-template-columns: auto;
  width: auto;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.38);
  box-shadow: 0 18px 54px rgba(2, 6, 23, 0.28);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}

.app-window-overlay.is-merged-mirofish-app .app-window-title-immersive {
  display: none;
}

.app-window-overlay.is-merged-mirofish-app .app-window-content {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0b0b1a;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.app-window-content.has-aurora-brief {
  grid-template-rows: auto minmax(0, 1fr);
  padding: 14px;
}

.app-window-brief {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.46)),
    rgba(255, 255, 255, 0.46);
  box-shadow:
    0 18px 48px rgba(52, 67, 104, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(18px);
}

.app-window-brief p,
.app-window-brief h2,
.app-window-brief span,
.app-window-brief small {
  margin: 0;
}

.app-window-brief p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.app-window-brief h2 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 900;
  line-height: 1.15;
}

.app-window-brief > div:first-child > span {
  display: block;
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.54);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}

.app-window-brief small {
  display: block;
  margin-top: 8px;
  color: rgba(97, 80, 220, 0.68);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.25;
}

.app-window-brief small.brief-error {
  color: #b42323;
}

.app-window-brief-side {
  display: grid;
  justify-items: end;
  gap: 10px;
  min-width: 0;
}

.app-window-brief-refresh {
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.app-window-brief-refresh:hover,
.app-window-brief-refresh:focus-visible {
  border-color: rgba(121, 99, 255, 0.32);
  background: rgba(255, 255, 255, 0.74);
  outline: none;
  transform: translateY(-1px);
}

.app-window-brief-refresh:disabled {
  cursor: wait;
  opacity: 0.62;
  transform: none;
}

.app-window-brief-auto {
  margin-top: -4px;
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.app-window-brief-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(84px, 1fr));
  gap: 8px;
}

.app-window-brief-metrics article {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.42);
}

.app-window-brief-metrics span {
  color: rgba(21, 32, 51, 0.46);
  font-size: 9px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.app-window-brief-metrics strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 13px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-window-loading {
  display: grid;
  min-height: 360px;
  place-items: center;
  color: rgba(21, 32, 51, 0.58);
  font-size: 13px;
  font-weight: 800;
}

.app-window-content :deep(.quant-lab),
.app-window-content :deep(.mirofish-app-entry),
.app-window-content :deep(.mirofish-arena),
.app-window-content :deep(.lifeos-grid-dashboard),
.app-window-content :deep(.kanban-view),
.app-window-content :deep(.memory-view),
.app-window-content :deep(.files-view),
.app-window-content :deep(.jobs-view),
.app-window-content :deep(.history-view),
.app-window-content :deep(.history-panel),
.app-window-content :deep(.models-view),
.app-window-content :deep(.profiles-view),
.app-window-content :deep(.gateways-view),
.app-window-content :deep(.logs-view),
.app-window-content :deep(.usage-view),
.app-window-content :deep(.skills-view),
.app-window-content :deep(.plugins-view),
.app-window-content :deep(.code-intelligence-view),
.app-window-content :deep(.system-status-view),
.app-window-content :deep(.settings-view) {
  min-height: 100%;
}

.app-window-enter-active,
.app-window-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.app-window-enter-from,
.app-window-leave-to {
  opacity: 0;
  transform: scale(0.985) translateY(8px);
}

:global(.dark) .app-window-overlay {
  background:
    radial-gradient(900px 420px at 10% 12%, rgba(73, 97, 168, 0.32), transparent 64%),
    radial-gradient(760px 460px at 88% 8%, rgba(99, 69, 159, 0.28), transparent 62%),
    rgba(10, 13, 20, 0.8);
}

:global(.dark) .app-window-frame,
:global(.dark) .app-window-titlebar,
:global(.dark) .close-app-button,
:global(.dark) .app-window-brief-refresh,
:global(.dark) .app-window-brief,
:global(.dark) .app-window-brief-metrics article {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(16, 20, 30, 0.74);
}

:global(.dark) .app-window-title strong {
  color: rgba(237, 243, 255, 0.92);
}

:global(.dark) .app-window-title span,
:global(.dark) .app-window-loading,
:global(.dark) .app-window-brief > div:first-child > span,
:global(.dark) .app-window-brief-metrics span,
:global(.dark) .app-window-brief small {
  color: rgba(237, 243, 255, 0.62);
}

:global(.dark) .app-window-brief h2 {
  color: rgba(237, 243, 255, 0.92);
}

@media (max-width: 720px) {
  .app-window-overlay {
    padding: 8px;
  }

  .app-window-frame {
    border-radius: 18px;
  }

  .app-window-titlebar {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .close-app-button {
    display: none;
  }

  .app-window-content.has-aurora-brief {
    padding: 10px;
  }

  .app-window-brief {
    grid-template-columns: minmax(0, 1fr);
  }

  .app-window-brief-side {
    justify-items: stretch;
  }

  .app-window-brief-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
