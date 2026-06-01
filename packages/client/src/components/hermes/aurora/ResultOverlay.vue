<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import WidgetRenderer from '@/components/hermes/aurora/overlays/WidgetRenderer.vue'

const commanderStore = useAuroraCommanderStore()
const appWindowStore = useAuroraAppWindowStore()

function statToneClass(tone?: string): string {
  return tone ? `tone-${tone}` : 'tone-neutral'
}

function statusToneClass(status?: string): string {
  const normalized = (status || '').toLowerCase()
  if (['done', 'pass', 'ok', 'buy', 'success', 'saved'].includes(normalized)) return 'tone-success'
  if (['blocked', 'fail', 'error', 'reject', 'sell'].includes(normalized)) return 'tone-danger'
  if (['running', 'watch', 'warning', 'fallback', 'degraded'].includes(normalized)) return 'tone-warning'
  if (['todo', 'ready', 'hold', 'memory', 'journal'].includes(normalized)) return 'tone-info'
  return 'tone-neutral'
}

function priorityLabel(priority: number): string {
  if (priority >= 2) return 'High'
  if (priority === 1) return 'Medium'
  return 'Normal'
}

function expandResultApp() {
  const app = commanderStore.result?.widget?.app
  if (!app) return
  appWindowStore.openApp(app.kind, app.payload || null)
  commanderStore.clearPassiveResult()
}

function openGeneratedWidget(widgetName: string) {
  void commanderStore.routeInput(`open ${widgetName}`)
}

function formatWidgetDate(value: string | null): string {
  if (!value) return 'Not audited'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <Transition name="result-overlay">
    <aside
      v-if="commanderStore.isVisible"
      class="result-overlay"
      aria-label="Aurora legacy tool result"
      aria-live="polite"
    >
      <header class="result-overlay-header">
        <div class="result-title-group">
          <p class="result-kicker">Aurora Legacy Bridge</p>
          <h2>
            {{ commanderStore.pendingApproval?.title || commanderStore.result?.title || 'Working' }}
          </h2>
        </div>

        <NButton
          quaternary
          size="tiny"
          aria-label="Dismiss Result"
          @click="commanderStore.clear"
        >
          ×
        </NButton>
      </header>

      <section v-if="commanderStore.isRunning" class="result-loading">
        <span class="result-loading-dot" aria-hidden="true"></span>
        Bridging legacy module...
      </section>

      <section v-else-if="commanderStore.error" class="result-error">
        {{ commanderStore.error }}
      </section>

      <section v-else-if="commanderStore.pendingApproval" class="result-approval">
        <div class="result-meta-row">
          <span>{{ commanderStore.pendingApproval.toolName }}</span>
          <strong>{{ commanderStore.pendingApproval.securityLevel }}</strong>
        </div>
        <p>{{ commanderStore.pendingApproval.summary }}</p>
        <div class="result-json-box">
          <span>Arguments</span>
          <pre>{{ commanderStore.pendingApproval.argsJson }}</pre>
        </div>
        <p class="result-governance-note">
          Review this request in the Aurora Governance confirmation dialog.
        </p>
      </section>

      <section v-else-if="commanderStore.result" class="result-content">
        <div class="result-meta-row">
          <span>{{ commanderStore.result.toolName }}</span>
          <strong>{{ commanderStore.result.securityLevel }}</strong>
        </div>
        <p class="result-summary">{{ commanderStore.result.summary }}</p>

        <template v-if="commanderStore.result.widget?.type === 'task-list'">
          <section class="widget-card task-widget" aria-label="Aurora task widget">
            <header class="widget-header">
              <div>
                <p class="widget-kicker">List / Task Widget</p>
                <h3>{{ commanderStore.result.widget.title }}</h3>
              </div>
              <span class="widget-count">{{ commanderStore.result.widget.tasks.length }} tasks</span>
            </header>

            <div class="widget-stat-grid">
              <article
                v-for="stat in commanderStore.result.widget.stats"
                :key="stat.id"
                class="widget-stat"
                :class="statToneClass(stat.tone)"
              >
                <span>{{ stat.label }}</span>
                <strong>{{ stat.value }}</strong>
                <small v-if="stat.detail">{{ stat.detail }}</small>
              </article>
            </div>

            <p
              v-if="commanderStore.result.widget.tasks.length === 0"
              class="widget-empty"
            >
              {{ commanderStore.result.widget.emptyText }}
            </p>

            <div v-else class="task-list">
              <article
                v-for="task in commanderStore.result.widget.tasks"
                :key="task.id"
                class="task-row"
              >
                <span
                  class="task-checkbox"
                  :class="{ checked: task.checked }"
                  role="checkbox"
                  :aria-checked="task.checked"
                  :aria-label="`Task ${task.title}`"
                >
                  <svg v-if="task.checked" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m20 6-11 11-5-5" />
                  </svg>
                </span>
                <div class="task-main">
                  <strong>{{ task.title }}</strong>
                  <p v-if="task.body">{{ task.body }}</p>
                  <small v-if="task.meta">{{ task.meta }}</small>
                </div>
                <div class="task-tags">
                  <span class="widget-tag" :class="statusToneClass(task.status)">
                    {{ task.status }}
                  </span>
                  <span class="widget-tag tone-neutral">
                    {{ priorityLabel(task.priority) }}
                  </span>
                </div>
              </article>
            </div>
          </section>
        </template>

        <template v-else-if="commanderStore.result.widget?.type === 'metric-grid'">
          <section class="widget-card metric-widget" aria-label="Aurora Quant Lab metric widget">
            <header class="widget-header">
              <div>
                <p class="widget-kicker">Data / Metric Widget</p>
                <h3>{{ commanderStore.result.widget.title }}</h3>
              </div>
              <div class="widget-actions">
                <button
                  v-if="commanderStore.result.widget.app"
                  class="widget-expand-button"
                  type="button"
                  @click="expandResultApp"
                >
                  {{ commanderStore.result.widget.app.label }}
                </button>
                <span class="widget-count">{{ commanderStore.result.widget.picks.length }} picks</span>
              </div>
            </header>

            <div class="widget-stat-grid">
              <article
                v-for="metric in commanderStore.result.widget.metrics"
                :key="metric.id"
                class="widget-stat"
                :class="statToneClass(metric.tone)"
              >
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
                <small v-if="metric.detail">{{ metric.detail }}</small>
              </article>
            </div>

            <div class="quant-pick-grid">
              <article
                v-for="pick in commanderStore.result.widget.picks"
                :key="pick.id"
                class="quant-pick-card"
              >
                <header>
                  <strong>{{ pick.ticker }}</strong>
                  <span class="widget-tag" :class="statusToneClass(pick.action)">
                    {{ pick.action }}
                  </span>
                </header>
                <div class="quant-metrics">
                  <div>
                    <span>Score</span>
                    <strong>{{ pick.score }}</strong>
                  </div>
                  <div>
                    <span>Risk</span>
                    <strong>{{ pick.risk }}</strong>
                  </div>
                  <div>
                    <span>Price</span>
                    <strong>{{ pick.price }}</strong>
                  </div>
                </div>
                <p>{{ pick.reason }}</p>
                <footer>
                  <span>{{ pick.trend }}</span>
                  <span v-if="pick.confidence">{{ pick.confidence }} confidence</span>
                </footer>
              </article>
            </div>

            <p v-if="commanderStore.result.widget.footer" class="widget-footnote">
              {{ commanderStore.result.widget.footer }}
            </p>
          </section>
        </template>

        <template v-else-if="commanderStore.result.widget?.type === 'financial-dashboard'">
          <section class="widget-card financial-widget" aria-label="Aurora LifeOS financial widget">
            <header class="widget-header">
              <div>
                <p class="widget-kicker">Financial Dashboard</p>
                <h3>{{ commanderStore.result.widget.title }}</h3>
              </div>
              <div class="widget-actions">
                <button
                  v-if="commanderStore.result.widget.app"
                  class="widget-expand-button"
                  type="button"
                  @click="expandResultApp"
                >
                  {{ commanderStore.result.widget.app.label }}
                </button>
                <span class="widget-count">LifeOS</span>
              </div>
            </header>

            <div class="widget-stat-grid financial-stat-grid">
              <article
                v-for="metric in commanderStore.result.widget.metrics"
                :key="metric.id"
                class="widget-stat"
                :class="statToneClass(metric.tone)"
              >
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
                <small v-if="metric.detail">{{ metric.detail }}</small>
              </article>
            </div>

            <div class="financial-lane-grid">
              <section class="financial-lane" aria-label="LifeOS budget lane">
                <header>
                  <span>Budget Guard</span>
                  <strong>{{ commanderStore.result.widget.budgetLines.length }}</strong>
                </header>
                <article
                  v-for="line in commanderStore.result.widget.budgetLines"
                  :key="line.id"
                  class="financial-line"
                >
                  <div>
                    <strong>{{ line.label }}</strong>
                    <small v-if="line.detail">{{ line.detail }}</small>
                  </div>
                  <span class="widget-tag" :class="statToneClass(line.tone)">
                    {{ line.value }}
                  </span>
                </article>
              </section>

              <section class="financial-lane" aria-label="LifeOS portfolio lane">
                <header>
                  <span>Portfolio Exposure</span>
                  <strong>{{ commanderStore.result.widget.portfolioLines.length }}</strong>
                </header>
                <article
                  v-for="line in commanderStore.result.widget.portfolioLines"
                  :key="line.id"
                  class="financial-line"
                >
                  <div>
                    <strong>{{ line.label }}</strong>
                    <small v-if="line.detail">{{ line.detail }}</small>
                  </div>
                  <span class="widget-tag" :class="statToneClass(line.tone)">
                    {{ line.value }}
                  </span>
                </article>
              </section>
            </div>

            <p v-if="commanderStore.result.widget.footer" class="widget-footnote">
              {{ commanderStore.result.widget.footer }}
            </p>
          </section>
        </template>

        <template v-else-if="commanderStore.result.widget?.type === 'memory-snippets'">
          <section class="widget-card memory-widget" aria-label="Aurora memory widget">
            <header class="widget-header">
              <div>
                <p class="widget-kicker">Memory Widget</p>
                <h3>{{ commanderStore.result.widget.title }}</h3>
              </div>
              <span class="widget-count">{{ commanderStore.result.widget.snippets.length }} hits</span>
            </header>

            <p class="memory-query">
              Query: <strong>{{ commanderStore.result.widget.query }}</strong>
            </p>

            <p
              v-if="commanderStore.result.widget.snippets.length === 0"
              class="widget-empty"
            >
              {{ commanderStore.result.widget.emptyText }}
            </p>

            <div v-else class="memory-snippet-list">
              <article
                v-for="snippet in commanderStore.result.widget.snippets"
                :key="snippet.id"
                class="memory-snippet"
              >
                <header>
                  <strong>{{ snippet.title }}</strong>
                  <span class="memory-tag-row">
                    <span class="widget-tag tone-info">Source: {{ snippet.source }}</span>
                    <span class="widget-tag tone-success">Confidence: {{ snippet.confidence }}</span>
                  </span>
                </header>
                <blockquote>{{ snippet.snippet }}</blockquote>
              </article>
            </div>
          </section>
        </template>

        <template v-else-if="commanderStore.result.widget?.type === 'generated-widget'">
          <section class="widget-card generated-widget" aria-label="Aurora generated widget">
            <WidgetRenderer
              :widget-name="commanderStore.result.widget.widgetName"
              :component-path="commanderStore.result.widget.componentPath"
            />
          </section>
        </template>

        <template v-else-if="commanderStore.result.widget?.type === 'generated-widget-library'">
          <section class="widget-card generated-widget-library" aria-label="Aurora generated widget library">
            <header class="widget-header">
              <div>
                <p class="widget-kicker">Generated Widgets</p>
                <h3>{{ commanderStore.result.widget.title }}</h3>
              </div>
              <div class="widget-actions">
                <span class="widget-count">{{ commanderStore.result.widget.manifestSource }}</span>
                <span class="widget-count">{{ commanderStore.result.widget.widgets.length }} widgets</span>
              </div>
            </header>

            <p
              v-if="commanderStore.result.widget.widgets.length === 0"
              class="widget-empty"
            >
              {{ commanderStore.result.widget.emptyText }}
            </p>

            <div v-else class="generated-widget-grid">
              <article
                v-for="widget in commanderStore.result.widget.widgets"
                :key="widget.id"
                class="generated-widget-card"
                :class="{ 'not-loadable': !widget.loadable }"
              >
                <div>
                  <strong>{{ widget.widgetName }}</strong>
                  <small>{{ widget.componentPath }}</small>
                  <p v-if="widget.spec">{{ widget.spec }}</p>
                  <span class="generated-widget-meta">
                    <span class="widget-tag" :class="widget.securityStatus === 'passed' ? 'tone-success' : 'tone-danger'">
                      {{ widget.securityStatus }}
                    </span>
                    <span class="widget-tag" :class="widget.loadable ? 'tone-info' : 'tone-warning'">
                      {{ widget.loadable ? 'Loadable' : 'Reload needed' }}
                    </span>
                    <span class="widget-tag tone-neutral">
                      {{ widget.source }}
                    </span>
                    <span v-if="widget.permissions" class="widget-tag tone-neutral">
                      {{ widget.permissions.network ? 'Network allowed' : 'No network' }}
                    </span>
                    <span v-if="widget.permissions" class="widget-tag tone-neutral">
                      {{ widget.permissions.workingMemory ? 'Context allowed' : 'No context' }}
                    </span>
                    <span class="widget-tag tone-neutral">
                      {{ formatWidgetDate(widget.deployedAt) }}
                    </span>
                  </span>
                </div>
                <button
                  class="widget-expand-button"
                  type="button"
                  :disabled="!widget.loadable"
                  @click="openGeneratedWidget(widget.widgetName)"
                >
                  {{ widget.loadable ? 'Open' : 'Unavailable' }}
                </button>
              </article>
            </div>
          </section>
        </template>

        <template v-else>
          <div
            v-for="section in commanderStore.result.sections"
            :key="section.title"
            class="result-section"
          >
            <h3>{{ section.title }}</h3>
            <p v-if="section.body">{{ section.body }}</p>
            <div v-if="section.items?.length" class="result-item-list">
              <article
                v-for="item in section.items"
                :key="item.id"
                class="result-item"
              >
                <div>
                  <strong>{{ item.title }}</strong>
                  <small v-if="item.meta">{{ item.meta }}</small>
                </div>
                <span v-if="item.status" class="result-item-status">{{ item.status }}</span>
              </article>
            </div>
          </div>
        </template>

        <details v-if="!commanderStore.result.widget" class="result-json-box">
          <summary>JSON</summary>
          <pre>{{ commanderStore.result.rawJson }}</pre>
        </details>
      </section>
    </aside>
  </Transition>
</template>

<style scoped lang="scss">
.result-overlay {
  position: absolute;
  bottom: clamp(96px, 10vh, 132px);
  left: 50%;
  z-index: 1500;
  display: flex;
  width: min(760px, calc(100% - 48px));
  max-height: min(680px, calc(100% - 132px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--aurora-glass-border, rgba(255, 255, 255, 0.62));
  border-radius: 22px;
  color: var(--aurora-text, #172033);
  background: var(--aurora-glass-bg-strong, rgba(255, 255, 255, 0.72));
  box-shadow: var(--aurora-glass-shadow, 0 20px 64px rgba(66, 84, 117, 0.2));
  backdrop-filter: blur(24px);
  transform: translateX(-50%);
}

.result-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 58px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid rgba(92, 113, 148, 0.14);
}

.result-title-group {
  min-width: 0;
}

.result-kicker {
  margin: 0 0 4px;
  color: rgba(21, 32, 51, 0.52);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.result-overlay h2 {
  margin: 0;
  overflow: hidden;
  color: #142033;
  font-size: 16px;
  font-weight: 850;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-content,
.result-approval,
.result-loading,
.result-error {
  min-height: 0;
  overflow: auto;
  padding: 14px;
}

.result-loading {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: rgba(21, 32, 51, 0.68);
  font-size: 13px;
  font-weight: 700;
}

.result-loading-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #2bd1ff;
  box-shadow: 0 0 12px rgba(43, 209, 255, 0.72);
}

.result-error {
  color: #9f2d2d;
  font-size: 13px;
  line-height: 1.45;
}

.result-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: rgba(21, 32, 51, 0.52);
  font-size: 11px;
  font-weight: 800;
}

.result-meta-row strong {
  flex: 0 0 auto;
  padding: 4px 7px;
  border: 1px solid rgba(43, 209, 255, 0.22);
  border-radius: 999px;
  color: #117da0;
  background: rgba(43, 209, 255, 0.08);
  font-size: 10px;
  line-height: 1.1;
}

.result-summary,
.result-approval p {
  margin: 10px 0 0;
  color: rgba(21, 32, 51, 0.68);
  font-size: 13px;
  line-height: 1.45;
}

.result-section {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.46);
}

.result-section h3 {
  margin: 0;
  color: rgba(21, 32, 51, 0.82);
  font-size: 13px;
  font-weight: 850;
  line-height: 1.2;
}

.result-section p {
  margin: 8px 0 0;
  color: rgba(21, 32, 51, 0.66);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.result-item-list {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.result-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 9px 10px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.5);
}

.result-item strong,
.result-item small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-item strong {
  color: rgba(21, 32, 51, 0.8);
  font-size: 12px;
  line-height: 1.2;
}

.result-item small {
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  line-height: 1.2;
}

.result-item-status {
  padding: 4px 7px;
  border-radius: 999px;
  color: #16724b;
  background: rgba(52, 211, 153, 0.12);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
}

.widget-card {
  display: grid;
  gap: 13px;
  margin-top: 14px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.48);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.68), rgba(255, 255, 255, 0.42)),
    rgba(255, 255, 255, 0.56);
  box-shadow:
    0 8px 32px rgba(31, 38, 135, 0.07),
    inset 0 1px 0 rgba(255, 255, 255, 0.62);
  backdrop-filter: blur(16px);
}

.widget-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.widget-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
}

.widget-expand-button {
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid rgba(121, 99, 255, 0.2);
  border-radius: 999px;
  color: #6150dc;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.48)),
    rgba(255, 255, 255, 0.58);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
  cursor: pointer;
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  white-space: nowrap;
  transition: all var(--aurora-ease, 0.3s cubic-bezier(0.2, 0, 0, 1));
}

.widget-expand-button:hover {
  border-color: rgba(121, 99, 255, 0.38);
  background: rgba(255, 255, 255, 0.76);
  transform: translateY(-1px);
}

.widget-expand-button:disabled {
  opacity: 0.54;
  cursor: not-allowed;
  transform: none;
}

.widget-kicker {
  margin: 0 0 5px;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.widget-header h3 {
  margin: 0;
  color: rgba(21, 32, 51, 0.86);
  font-size: 16px;
  font-weight: 900;
  line-height: 1.18;
}

.widget-count {
  flex: 0 0 auto;
  padding: 5px 8px;
  border: 1px solid rgba(121, 99, 255, 0.2);
  border-radius: 999px;
  color: #7059f7;
  background: rgba(121, 99, 255, 0.08);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
}

.widget-stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}

.widget-stat {
  min-width: 0;
  min-height: 72px;
  padding: 11px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.48);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
}

.widget-stat span,
.quant-metrics span {
  display: block;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.15;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.widget-stat strong {
  display: block;
  margin-top: 7px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.84);
  font-size: 18px;
  font-weight: 900;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget-stat small {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget-empty {
  margin: 0;
  padding: 12px;
  border: 1px dashed rgba(76, 98, 131, 0.18);
  border-radius: 14px;
  color: rgba(21, 32, 51, 0.58);
  background: rgba(255, 255, 255, 0.34);
  font-size: 12px;
  line-height: 1.5;
}

.task-list,
.memory-snippet-list {
  display: grid;
  gap: 9px;
}

.task-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 10px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.46);
}

.task-checkbox {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid rgba(121, 99, 255, 0.28);
  border-radius: 999px;
  color: #fff;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.38)),
    rgba(255, 255, 255, 0.58);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.58),
    0 8px 18px rgba(121, 99, 255, 0.08);
}

.task-checkbox.checked {
  border-color: rgba(121, 99, 255, 0.48);
  background: linear-gradient(135deg, #6b6dff, #9f63ff 58%, #c45cff);
  box-shadow:
    0 8px 22px rgba(121, 99, 255, 0.22),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.task-main {
  min-width: 0;
}

.task-main strong {
  display: block;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.82);
  font-size: 13px;
  font-weight: 850;
  line-height: 1.22;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-main p,
.memory-query {
  margin: 5px 0 0;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.task-main small {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.42);
  font-size: 10px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-tags {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}

.widget-tag {
  display: inline-flex;
  align-items: center;
  max-width: 128px;
  min-height: 22px;
  overflow: hidden;
  padding: 4px 7px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tone-success {
  color: #16724b;
  border-color: rgba(52, 211, 153, 0.24);
  background: rgba(52, 211, 153, 0.12);
}

.tone-info {
  color: #4756d8;
  border-color: rgba(121, 99, 255, 0.22);
  background: rgba(121, 99, 255, 0.1);
}

.tone-warning {
  color: #9f5f00;
  border-color: rgba(245, 158, 11, 0.24);
  background: rgba(245, 158, 11, 0.12);
}

.tone-danger {
  color: #9f2d2d;
  border-color: rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.1);
}

.tone-neutral {
  color: rgba(21, 32, 51, 0.58);
  border-color: rgba(76, 98, 131, 0.1);
  background: rgba(255, 255, 255, 0.44);
}

.quant-pick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.financial-stat-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.financial-lane-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.financial-lane {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.42);
}

.financial-lane header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.financial-lane header strong {
  color: #7059f7;
  font-size: 12px;
}

.financial-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 9px;
  border: 1px solid rgba(76, 98, 131, 0.08);
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.42);
}

.financial-line div {
  min-width: 0;
}

.financial-line strong,
.financial-line small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.financial-line strong {
  color: rgba(21, 32, 51, 0.8);
  font-size: 12px;
  font-weight: 850;
  line-height: 1.2;
}

.financial-line small {
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.2;
}

.quant-pick-card {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
}

.quant-pick-card header,
.memory-snippet header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.memory-tag-row {
  display: inline-flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}

.quant-pick-card header strong,
.memory-snippet header strong {
  min-width: 0;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.84);
  font-size: 15px;
  font-weight: 900;
  line-height: 1.12;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quant-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.quant-metrics div {
  min-width: 0;
  padding: 8px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.42);
}

.quant-metrics strong {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.82);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quant-pick-card p,
.widget-footnote,
.memory-snippet blockquote {
  margin: 0;
  color: rgba(21, 32, 51, 0.62);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.quant-pick-card footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: rgba(21, 32, 51, 0.44);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.2;
}

.widget-footnote {
  padding: 10px 12px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 14px;
  background: rgba(121, 99, 255, 0.06);
}

.memory-query {
  margin: 0;
}

.memory-query strong {
  color: rgba(21, 32, 51, 0.78);
}

.memory-snippet {
  display: grid;
  gap: 9px;
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.46);
}

.memory-snippet blockquote {
  padding-left: 10px;
  border-left: 3px solid rgba(121, 99, 255, 0.28);
}

.generated-widget-grid {
  display: grid;
  gap: 10px;
}

.generated-widget-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 12px;
  border: 1px solid rgba(76, 98, 131, 0.1);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
}

.generated-widget-card.not-loadable {
  border-style: dashed;
}

.generated-widget-card div {
  min-width: 0;
}

.generated-widget-card strong,
.generated-widget-card small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generated-widget-card strong {
  color: rgba(21, 32, 51, 0.84);
  font-size: 14px;
  font-weight: 900;
  line-height: 1.2;
}

.generated-widget-card small {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.2;
}

.generated-widget-card p {
  display: -webkit-box;
  overflow: hidden;
  margin: 8px 0 0;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.generated-widget-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}

.result-json-box {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid rgba(76, 98, 131, 0.13);
  border-radius: 8px;
  background: rgba(248, 251, 255, 0.62);
}

.result-json-box summary,
.result-json-box > span {
  display: block;
  padding: 9px 11px;
  color: rgba(21, 32, 51, 0.56);
  cursor: pointer;
  font-size: 11px;
  font-weight: 850;
  line-height: 1.1;
}

.result-json-box pre {
  margin: 0;
  max-height: 210px;
  overflow: auto;
  padding: 11px;
  border-top: 1px solid rgba(76, 98, 131, 0.1);
  color: rgba(21, 32, 51, 0.76);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.result-governance-note {
  padding: 9px 10px;
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 10px;
  color: #8a5a00;
  background: rgba(245, 158, 11, 0.1);
  font-weight: 800;
}

.result-overlay-enter-active,
.result-overlay-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.result-overlay-enter-from,
.result-overlay-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px) scale(0.985);
}

:global(.dark) .result-overlay {
  border-color: rgba(255, 255, 255, 0.12);
  color: #edf3ff;
  background:
    linear-gradient(135deg, rgba(29, 35, 48, 0.9), rgba(17, 21, 31, 0.78)),
    rgba(18, 22, 32, 0.78);
  box-shadow:
    0 22px 70px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

:global(.dark) .result-overlay-header,
:global(.dark) .result-json-box pre {
  border-color: rgba(255, 255, 255, 0.09);
}

:global(.dark) .result-overlay h2,
:global(.dark) .result-section h3,
:global(.dark) .result-item strong {
  color: #edf3ff;
}

:global(.dark) .result-kicker,
:global(.dark) .result-summary,
:global(.dark) .result-approval p,
:global(.dark) .result-section p,
:global(.dark) .result-meta-row,
:global(.dark) .result-item small,
:global(.dark) .result-json-box summary,
:global(.dark) .result-json-box > span,
:global(.dark) .result-json-box pre {
  color: rgba(237, 243, 255, 0.64);
}

:global(.dark) .result-section,
:global(.dark) .result-item,
:global(.dark) .result-json-box {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .widget-card,
:global(.dark) .widget-stat,
:global(.dark) .task-row,
:global(.dark) .quant-pick-card,
:global(.dark) .quant-metrics div,
:global(.dark) .financial-lane,
:global(.dark) .financial-line,
:global(.dark) .memory-snippet,
:global(.dark) .generated-widget-card,
:global(.dark) .widget-empty,
:global(.dark) .tone-neutral {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .widget-header h3,
:global(.dark) .widget-stat strong,
:global(.dark) .task-main strong,
:global(.dark) .quant-pick-card header strong,
:global(.dark) .quant-metrics strong,
:global(.dark) .financial-line strong,
:global(.dark) .memory-snippet header strong,
:global(.dark) .generated-widget-card strong,
:global(.dark) .memory-query strong {
  color: rgba(237, 243, 255, 0.9);
}

:global(.dark) .widget-kicker,
:global(.dark) .widget-stat span,
:global(.dark) .widget-stat small,
:global(.dark) .quant-metrics span,
:global(.dark) .task-main p,
:global(.dark) .task-main small,
:global(.dark) .quant-pick-card p,
:global(.dark) .quant-pick-card footer,
:global(.dark) .financial-lane header,
:global(.dark) .financial-line small,
:global(.dark) .widget-footnote,
:global(.dark) .memory-query,
:global(.dark) .memory-snippet blockquote,
:global(.dark) .generated-widget-card p,
:global(.dark) .generated-widget-card small,
:global(.dark) .widget-empty {
  color: rgba(237, 243, 255, 0.62);
}

@media (max-width: 720px) {
  .result-overlay {
    bottom: 88px;
    right: 12px;
    left: 12px;
    width: auto;
    max-height: calc(100% - 112px);
    transform: none;
  }

  .result-overlay-enter-from,
  .result-overlay-leave-to {
    transform: translateY(12px) scale(0.985);
  }

  .widget-stat-grid,
  .quant-pick-grid,
  .financial-lane-grid {
    grid-template-columns: 1fr;
  }

  .task-row {
    grid-template-columns: 22px minmax(0, 1fr);
  }

  .task-tags {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>
