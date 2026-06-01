<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useMemoryQueueStore } from '@/stores/hermes/memory-queue'
import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'
import { useAuroraIntentAuditStore, type AuroraIntentAuditRecord } from '@/stores/hermes/aurora-intent-audit'
import { useAuroraGovernanceStore } from '@/stores/hermes/aurora-governance'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAuroraWorkingMemoryStore } from '@/stores/hermes/working-memory'
import {
  AURORA_COMMAND_CAPABILITIES,
  type AuroraCapabilityStatus,
  type AuroraCommandCapability,
} from '@/services/hermes/aurora/capability-manifest'
import { auroraEventBus, type AuroraEventEnvelope } from '@/services/hermes/aurora/aurora-event-bus'
import { ToolRegistry } from '@/services/hermes/aurora/tool-registry'

const appStore = useAppStore()
const chatStore = useChatStore()
const commanderStore = useAuroraCommanderStore()
const memoryQueueStore = useMemoryQueueStore()
const vibeCodingStore = useVibeCodingStore()
const intentAuditStore = useAuroraIntentAuditStore()
const governanceStore = useAuroraGovernanceStore()
const appWindowStore = useAuroraAppWindowStore()
const workingMemoryStore = useAuroraWorkingMemoryStore()
const auditSearchQuery = ref('')
const auditFileInput = ref<HTMLInputElement | null>(null)
const auditImportMessage = ref('')
const selectedAuditRecord = ref<AuroraIntentAuditRecord | null>(null)
const replayingAuditRecordId = ref<string | null>(null)
const auditFilter = ref<'all' | 'governance' | 'tools' | 'apps' | 'fallback'>('all')
const MAX_AUDIT_ROWS = 24
const AUDIT_COLLAPSE_WINDOW = 80

type CoverageStatus = AuroraCapabilityStatus
type CommandCoverageRow = AuroraCommandCapability
type AuditDisplayRow = {
  key: string
  record: AuroraIntentAuditRecord
  count: number
}

const toolCount = computed(() => ToolRegistry.all().length)
const lockedTools = computed(() =>
  ToolRegistry.all().filter(tool => tool.securityLevel === 'L3_Approval' || tool.securityLevel === 'L4_Locked').length,
)

const statusItems = computed(() => [
  {
    label: 'Hermes backend',
    value: appStore.connected ? 'Connected' : 'Offline',
    tone: appStore.connected ? 'good' : 'warn',
  },
  {
    label: 'ToolRegistry',
    value: `${toolCount.value} tools`,
    tone: toolCount.value > 0 ? 'good' : 'warn',
  },
  {
    label: 'Security Matrix',
    value: `${lockedTools.value} gated`,
    tone: lockedTools.value > 0 ? 'good' : 'warn',
  },
  {
    label: 'Governance',
    value: governanceStore.pendingCount > 0 ? `${governanceStore.pendingCount} awaiting decision` : 'Ready',
    tone: governanceStore.hasPendingConfirmation ? 'warn' : 'good',
  },
  {
    label: 'Memory Queue',
    value: `${memoryQueueStore.pendingCount} pending`,
    tone: memoryQueueStore.pendingCount > 0 ? 'warn' : 'good',
  },
  {
    label: 'Working Memory',
    value: workingMemoryStore.contextLockEnabled
      ? workingMemoryStore.hasContextLock ? 'Context locked' : 'Ready'
      : 'Paused',
    tone: workingMemoryStore.contextLockEnabled ? 'good' : 'warn',
  },
  {
    label: 'Event Bus',
    value: `${auroraEventBus.timeline.value.length} events`,
    tone: auroraEventBus.timeline.value.length > 0 ? 'good' : 'warn',
  },
  {
    label: 'Vibe Pipeline',
    value: vibeCodingStore.status.replace('_', ' '),
    tone: vibeCodingStore.status === 'awaiting_approval' ? 'warn' : vibeCodingStore.status === 'rejected' ? 'danger' : 'good',
  },
  {
    label: 'Hermes stream',
    value: chatStore.isRunActive ? 'Active' : 'Idle',
    tone: chatStore.isRunActive ? 'warn' : 'good',
  },
  {
    label: 'Intent Audit',
    value: `${intentAuditStore.records.length} events · ${intentAuditStore.syncState}`,
    tone: intentAuditStore.syncState === 'error'
      ? 'danger'
      : intentAuditStore.syncState === 'offline'
        ? 'warn'
        : intentAuditStore.records.length > 0 ? 'good' : 'warn',
  },
])

const neuralEventRows = computed(() => auroraEventBus.timeline.value.slice(0, 8))

const workingMemorySummaryLines = computed(() =>
  workingMemoryStore.contextSummary
    ? workingMemoryStore.contextSummary.split('\n').filter(Boolean).slice(0, 4)
    : [],
)

function eventPayloadSummary(event: AuroraEventEnvelope): string {
  const payload = event.payload as unknown as Record<string, unknown>
  const candidates = [
    payload.title,
    payload.topic,
    payload.kind,
    payload.url,
    payload.widgetName,
    payload.source,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (candidates.length > 0) return candidates.slice(0, 2).join(' · ')
  try {
    return JSON.stringify(payload).slice(0, 120)
  } catch {
    return 'payload unavailable'
  }
}

function formatEventTime(timestamp: string): string {
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

const isPipelineFocusMode = computed(() =>
  vibeCodingStore.isVisible && !appWindowStore.isOpen,
)

const compactStatusItems = computed(() => {
  const priorityLabels = new Set(['Hermes backend', 'Security Matrix', 'Governance', 'Vibe Pipeline'])
  return statusItems.value.filter(item => priorityLabels.has(item.label))
})

const demoSteps = computed(() => [
  {
    id: 'launcher',
    index: '01',
    title: 'Clean Launcher',
    status: appStore.legacyConsoleRetired || !appStore.isAdvancedConsoleOpen ? 'complete' : 'ready',
    meta: appStore.legacyConsoleRetired
      ? 'Legacy console retired'
      : appStore.isAdvancedConsoleOpen ? 'Legacy console open' : 'Intent-first shell',
  },
  {
    id: 'legacy',
    index: '02',
    title: 'Legacy Bridge',
    status: commanderStore.result || commanderStore.pendingApproval ? 'complete' : 'ready',
    meta: 'Kanban, Memory, LifeOS, Quant',
  },
  {
    id: 'memory',
    index: '03',
    title: 'Memory Governance',
    status: memoryQueueStore.pendingCount > 0 || memoryQueueStore.savedMemories.length > 0 ? 'complete' : 'ready',
    meta: `${memoryQueueStore.pendingCount} pending`,
  },
  {
    id: 'build',
    index: '04',
    title: 'Build Sandbox',
    status: vibeCodingStore.status === 'idle' ? 'ready' : 'complete',
    meta: vibeCodingStore.status.replace('_', ' '),
  },
  {
    id: 'release',
    index: '05',
    title: 'v0.1 RC',
    status: 'complete',
    meta: 'MVP checks installed',
  },
])

const commandCoverageRows = computed<CommandCoverageRow[]>(() => {
  const registeredToolIds = new Set(ToolRegistry.all().map(tool => tool.id))
  const rows: CommandCoverageRow[] = AURORA_COMMAND_CAPABILITIES.map(row => ({ ...row }))

  return rows.map(row => {
    if (row.status) return row
    const hasTools = row.toolIds?.every(toolId => registeredToolIds.has(toolId)) ?? false
    return {
      ...row,
      status: hasTools ? 'ready' : 'partial',
    }
  })
})

const commandCoverageStats = computed(() => {
  const total = commandCoverageRows.value.length
  const ready = commandCoverageRows.value.filter(row => row.status === 'ready').length
  const partial = commandCoverageRows.value.filter(row => row.status === 'partial').length
  const legacy = commandCoverageRows.value.filter(row => row.status === 'legacy').length
  return {
    ready,
    partial,
    legacy,
    total,
    percent: total > 0 ? Math.round((ready / total) * 100) : 0,
  }
})

function isGovernanceAudit(record: AuroraIntentAuditRecord | null): boolean {
  return Boolean(record?.status?.startsWith('approval_'))
}

function matchesAuditFilter(record: AuroraIntentAuditRecord): boolean {
  if (auditFilter.value === 'governance') return isGovernanceAudit(record)
  if (auditFilter.value === 'tools') return Boolean(record.toolName) && !isGovernanceAudit(record)
  if (auditFilter.value === 'apps') return Boolean(record.appKind)
  if (auditFilter.value === 'fallback') return record.status === 'fallback'
  return true
}

function countAuditFilter(filter: typeof auditFilter.value): number {
  return intentAuditStore.records.filter(record => {
    if (filter === 'governance') return isGovernanceAudit(record)
    if (filter === 'tools') return Boolean(record.toolName) && !isGovernanceAudit(record)
    if (filter === 'apps') return Boolean(record.appKind)
    if (filter === 'fallback') return record.status === 'fallback'
    return true
  }).length
}

const auditFilterOptions = computed(() => [
  { key: 'all' as const, label: 'All', count: countAuditFilter('all') },
  { key: 'governance' as const, label: 'Governance', count: countAuditFilter('governance') },
  { key: 'tools' as const, label: 'Tools', count: countAuditFilter('tools') },
  { key: 'apps' as const, label: 'Apps', count: countAuditFilter('apps') },
  { key: 'fallback' as const, label: 'Fallback', count: countAuditFilter('fallback') },
])

const filteredAuditRecords = computed(() => {
  const query = auditSearchQuery.value.trim().toLowerCase()
  const scopedRecords = intentAuditStore.records.filter(matchesAuditFilter)
  if (!query) return scopedRecords.slice(0, AUDIT_COLLAPSE_WINDOW)

  return scopedRecords
    .filter(record => [
      record.input,
      record.status,
      record.toolName,
      record.toolId,
      record.appKind,
      record.securityLevel,
      record.summary,
    ].filter(Boolean).join(' ').toLowerCase().includes(query))
    .slice(0, AUDIT_COLLAPSE_WINDOW)
})

function collapseAuditKey(record: AuroraIntentAuditRecord): string {
  if (record.status === 'app_opened') {
    return [
      record.status,
      record.appKind || 'app',
      record.input.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').trim(),
    ].join(':')
  }

  if (record.status === 'fallback') {
    return `${record.status}:${record.input.trim().toLowerCase()}`
  }

  return record.id
}

const auditDisplayRows = computed<AuditDisplayRow[]>(() => {
  const collapsed = new Map<string, AuditDisplayRow>()
  for (const record of filteredAuditRecords.value) {
    const key = collapseAuditKey(record)
    const existing = collapsed.get(key)
    if (existing) {
      existing.count += 1
      if (new Date(record.timestamp).getTime() > new Date(existing.record.timestamp).getTime()) {
        existing.record = record
      }
    } else {
      collapsed.set(key, {
        key,
        record,
        count: 1,
      })
    }
  }
  return Array.from(collapsed.values()).slice(0, MAX_AUDIT_ROWS)
})

const auditTimelineGroups = computed(() => {
  const formatter = new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const groups: Array<{ label: string; rows: AuditDisplayRow[] }> = []
  for (const row of auditDisplayRows.value) {
    const label = formatter.format(new Date(row.record.timestamp))
    const group = groups.find(item => item.label === label)
    if (group) {
      group.rows.push(row)
    } else {
      groups.push({ label, rows: [row] })
    }
  }
  return groups
})

function exportAuditLog() {
  const snapshot = intentAuditStore.exportSnapshot()
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aurora-intent-audit-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function openAuditImport() {
  auditImportMessage.value = ''
  auditFileInput.value?.click()
}

async function importAuditLog(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    const text = await file.text()
    const importedCount = intentAuditStore.importRecords(JSON.parse(text))
    auditImportMessage.value = importedCount > 0
      ? `Imported ${importedCount} audit events.`
      : 'No valid audit events found.'
  } catch {
    auditImportMessage.value = 'Import failed. Use an Aurora audit JSON export.'
  }
}

function selectAuditRecord(record: AuroraIntentAuditRecord) {
  selectedAuditRecord.value = record
}

function clearAuditLog() {
  selectedAuditRecord.value = null
  intentAuditStore.clear()
}

function setAuditFilter(filter: typeof auditFilter.value) {
  auditFilter.value = filter
}

function coverageStatusLabel(status: CoverageStatus | undefined): string {
  if (status === 'ready') return 'Ready'
  if (status === 'partial') return 'Partial'
  return 'Legacy'
}

function openCoverageApp(row: CommandCoverageRow) {
  if (!row.appKind) return
  selectedAuditRecord.value = null
  appWindowStore.openApp(row.appKind)
  appStore.setAuroraStatusOpen(false)
}

function isMiroFishDecisionAudit(record: AuroraIntentAuditRecord | null): boolean {
  return record?.toolId === 'quant.mirofish.run' &&
    record.payload?.source === 'mirofish-current-archive-compare'
}

function replayMiroFishArena(record: AuroraIntentAuditRecord | null) {
  if (!isMiroFishDecisionAudit(record)) return
  selectedAuditRecord.value = null
  appWindowStore.openApp('mirofish-arena', { replayRecord: record })
  appStore.setAuroraStatusOpen(false)
}

function auditDecision(record: AuroraIntentAuditRecord | null): string {
  if (!record) return 'n/a'
  if (record.status === 'approval_required') return 'Awaiting approval'
  if (record.status === 'approval_queued') return 'Approval queued'
  if (record.status === 'approval_approved') return 'Approved by user'
  if (record.status === 'approval_rejected') return 'Rejected by user'
  if (record.status === 'approval_expired') return 'Expired or cleared'
  if (record.status === 'rejected') return 'Rejected by user or policy'
  if (record.status === 'completed' && record.securityLevel?.includes('L')) return 'Approved or completed'
  if (record.status === 'app_opened') return 'Opened App Mode'
  if (record.status === 'fallback') return 'Routed to Hermes chat'
  return record.status.replace('_', ' ')
}

function auditRouteLabel(record: AuroraIntentAuditRecord | null): string {
  if (!record) return 'n/a'
  return record.toolName || record.appKind || 'Hermes fallback'
}

function formatAuditStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

function auditPayloadField(record: AuroraIntentAuditRecord | null, key: string): string {
  const value = record?.payload?.[key]
  if (typeof value === 'string') return value || 'n/a'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || typeof value === 'undefined') return 'n/a'
  try {
    return JSON.stringify(value)
  } catch {
    return 'unavailable'
  }
}

function auditPayloadShort(record: AuroraIntentAuditRecord | null, key: string, max = 180): string {
  const value = auditPayloadField(record, key)
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function auditPayloadJson(record: AuroraIntentAuditRecord | null): string {
  if (!record) return '{}'
  return JSON.stringify({
    id: record.id,
    timestamp: record.timestamp,
    input: record.input,
    status: record.status,
    route: auditRouteLabel(record),
    securityLevel: record.securityLevel,
    decision: auditDecision(record),
    summary: record.summary,
    payload: record.payload || {},
  }, null, 2)
}

async function replayAuditRecord(record: AuroraIntentAuditRecord | null) {
  const input = record?.input?.trim()
  if (!record || !input || replayingAuditRecordId.value) return
  const needsConfirmation = record.securityLevel === 'L3_Approval' || record.securityLevel === 'L4_Locked'
  if (needsConfirmation) {
    const approved = await governanceStore.requestConfirmation({
      title: 'Confirm high-risk replay',
      description: 'This audit event used an L3/L4 security level. Aurora will replay the original intent only after you explicitly confirm.',
      details: input,
      confirmLabel: 'Confirm Replay',
      cancelLabel: 'Cancel',
      source: 'Intent Audit Replay',
      contextKey: `intent-audit-replay:${record.id}`,
      auditInput: input,
      toolId: record.toolId,
      toolName: record.toolName || 'Intent Audit Replay',
      securityLevel: record.securityLevel,
      payload: {
        replayRecordId: record.id,
        replayStatus: record.status,
        originalSummary: record.summary,
      },
    })
    if (!approved) return
  }

  replayingAuditRecordId.value = record.id
  try {
    if (record.status === 'app_opened' && record.appKind) {
      appWindowStore.openApp(record.appKind, record.payload || null)
      selectedAuditRecord.value = null
      appStore.setAuroraStatusOpen(false)
      return
    }

    const handledByAurora = await commanderStore.routeInput(input)
    if (!handledByAurora) {
      commanderStore.clearPassiveResult()
      chatStore.sendMessage(input)
    }
    selectedAuditRecord.value = null
    appStore.setAuroraStatusOpen(false)
  } finally {
    replayingAuditRecordId.value = null
  }
}

function beginDemo() {
  appStore.setAdvancedConsoleOpen(false)
  commanderStore.clearPassiveResult()
}

function seedMemoryCandidate() {
  memoryQueueStore.proposeMemory({
    content: 'Aurora OS memories must be reviewed by the human before becoming long-term knowledge.',
    source: 'Manual',
    confidenceScore: 96,
  })
}

function startBuildDemo() {
  vibeCodingStore.start('Polish Aurora v0.1 result surfaces and run the sandbox checks.')
}

function formatAuditTime(timestamp: string): string {
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}
</script>

<template>
  <Transition name="aurora-status">
    <aside
      v-if="appStore.isAuroraStatusOpen"
      class="aurora-status-panel"
      :class="{ 'is-focus-hud': isPipelineFocusMode }"
      aria-label="Aurora System Status"
      aria-live="polite"
    >
      <template v-if="isPipelineFocusMode">
        <header class="aurora-status-header focus-hud-header">
          <div>
            <p>Aurora OS</p>
            <h2>v0.1 HUD</h2>
          </div>
          <NButton quaternary size="tiny" @click="appStore.setAuroraStatusOpen(false)">
            Hide
          </NButton>
        </header>

        <section class="focus-hud-grid" aria-label="Pipeline Focus Status">
          <article
            v-for="item in compactStatusItems"
            :key="item.label"
            class="focus-hud-cell"
            :class="`is-${item.tone}`"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </section>

        <footer class="focus-hud-footer">
          <span>Build focus active</span>
          <strong>{{ vibeCodingStore.status.replace('_', ' ') }}</strong>
        </footer>
      </template>

      <template v-else>
      <header class="aurora-status-header">
        <div>
          <p>Aurora OS</p>
          <h2>v0.1 Control</h2>
        </div>
        <NButton quaternary size="tiny" @click="appStore.setAuroraStatusOpen(false)">
          Close
        </NButton>
      </header>

      <section class="status-grid" aria-label="System Status">
        <article
          v-for="item in statusItems"
          :key="item.label"
          class="status-cell"
          :class="`is-${item.tone}`"
        >
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </article>
      </section>

      <section class="neural-events-panel" aria-label="Aurora Neural Events">
        <header>
          <div>
            <p>Neural Events</p>
            <strong>{{ neuralEventRows.length }} recent IPC signals</strong>
          </div>
          <div class="neural-actions">
            <NButton
              size="tiny"
              secondary
              :type="workingMemoryStore.contextLockEnabled ? 'success' : 'warning'"
              @click="workingMemoryStore.toggleContextLock"
            >
              {{ workingMemoryStore.contextLockEnabled ? 'Context Lock On' : 'Context Paused' }}
            </NButton>
            <NButton
              size="tiny"
              quaternary
              :disabled="!workingMemoryStore.hasContextLock && workingMemorySummaryLines.length === 0"
              @click="workingMemoryStore.clearAllContext"
            >
              Clear Context
            </NButton>
          </div>
        </header>

        <div class="working-memory-card" :class="{ paused: !workingMemoryStore.contextLockEnabled }">
          <span class="memory-lock-dot" aria-hidden="true"></span>
          <div>
            <strong>
              {{ workingMemoryStore.contextLockEnabled ? (workingMemoryStore.contextLabel || 'Context RAM ready') : 'Context RAM paused' }}
            </strong>
            <p v-if="workingMemorySummaryLines.length > 0">
              {{ workingMemorySummaryLines.join(' · ') }}
            </p>
            <p v-else>
              No active on-screen context captured yet.
            </p>
          </div>
        </div>

        <ol v-if="neuralEventRows.length > 0" class="neural-event-list">
          <li
            v-for="event in neuralEventRows"
            :key="event.id"
            class="neural-event-row"
          >
            <span>{{ event.type }}</span>
            <strong>{{ eventPayloadSummary(event) }}</strong>
            <time>{{ formatEventTime(event.timestamp) }}</time>
          </li>
        </ol>
        <p v-else class="neural-event-empty">
          No IPC events yet. Open an Aurora app or run a tool to light up the bus.
        </p>
      </section>

      <section class="demo-path" aria-label="Aurora Demo Path">
        <div class="demo-path-header">
          <p>Demo Path</p>
          <div class="demo-actions">
            <NButton size="tiny" secondary @click="beginDemo">
              Reset Shell
            </NButton>
            <NButton size="tiny" type="primary" @click="seedMemoryCandidate">
              Seed Memory
            </NButton>
          </div>
        </div>

        <ol class="demo-step-list">
          <li
            v-for="step in demoSteps"
            :key="step.id"
            class="demo-step"
            :class="`is-${step.status}`"
          >
            <span class="demo-index">{{ step.index }}</span>
            <span class="demo-copy">
              <strong>{{ step.title }}</strong>
              <small>{{ step.meta }}</small>
            </span>
            <span class="demo-dot" aria-hidden="true"></span>
          </li>
        </ol>

        <section class="command-coverage" aria-label="Aurora Command Coverage Matrix">
          <header>
            <p>
              Command Coverage
              <span>{{ commandCoverageStats.ready }}/{{ commandCoverageStats.total }} Aurora ready</span>
            </p>
            <strong>{{ commandCoverageStats.percent }}%</strong>
          </header>

          <div class="coverage-meter" aria-hidden="true">
            <span :style="{ width: `${commandCoverageStats.percent}%` }"></span>
          </div>

          <ol class="coverage-list">
            <li
              v-for="row in commandCoverageRows"
              :key="row.id"
              class="coverage-row"
              :class="`is-${row.status}`"
            >
              <div class="coverage-main">
                <span class="coverage-status">{{ coverageStatusLabel(row.status) }}</span>
                <strong>{{ row.label }}</strong>
                <small>{{ row.legacySurface }} -> {{ row.auroraEntry }}</small>
              </div>

              <div class="coverage-meta">
                <span>{{ row.mode }}</span>
                <span>{{ row.security }}</span>
              </div>

              <div class="coverage-action">
                <code>{{ row.command }}</code>
                <NButton
                  v-if="row.appKind"
                  size="tiny"
                  secondary
                  :aria-label="`Open ${row.label} coverage app`"
                  @click="openCoverageApp(row)"
                >
                  Open
                </NButton>
              </div>
            </li>
          </ol>
        </section>

        <section class="intent-audit" aria-label="Intent Audit Log">
          <div class="intent-audit-header">
            <p>
              Intent Audit
              <span>{{ intentAuditStore.isServerSynced ? 'server synced' : intentAuditStore.syncState }}</span>
            </p>
            <div class="intent-audit-actions">
              <NButton
                size="tiny"
                quaternary
                :disabled="intentAuditStore.records.length === 0"
                @click="exportAuditLog"
              >
                Export
              </NButton>
              <NButton size="tiny" quaternary @click="openAuditImport">
                Import
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="intentAuditStore.records.length === 0"
                @click="clearAuditLog"
              >
                Clear
              </NButton>
            </div>
          </div>

          <input
            v-model="auditSearchQuery"
            class="intent-audit-search"
            type="search"
            aria-label="Search Intent Audit"
            placeholder="Search intents, apps, tools..."
          />
          <div class="intent-audit-filters" aria-label="Intent Audit Filters">
            <button
              v-for="filter in auditFilterOptions"
              :key="filter.key"
              type="button"
              :class="{ active: auditFilter === filter.key }"
              :aria-pressed="auditFilter === filter.key"
              @click="setAuditFilter(filter.key)"
            >
              <span>{{ filter.label }}</span>
              <strong>{{ filter.count }}</strong>
            </button>
          </div>
          <input
            ref="auditFileInput"
            class="intent-audit-file"
            type="file"
            accept="application/json,.json"
            @change="importAuditLog"
          />
          <p v-if="auditImportMessage" class="intent-audit-empty">{{ auditImportMessage }}</p>

          <p v-if="intentAuditStore.records.length === 0" class="intent-audit-empty">
            No routed intents yet.
          </p>
          <p v-else-if="filteredAuditRecords.length === 0" class="intent-audit-empty">
            No audit events match this search.
          </p>

          <div v-else class="intent-audit-timeline" aria-label="Intent Audit Timeline">
            <section
              v-for="group in auditTimelineGroups"
              :key="group.label"
              class="intent-audit-day"
            >
              <h3>{{ group.label }}</h3>
              <ol class="intent-audit-list">
                <li
                  v-for="row in group.rows"
                  :key="row.key"
                  class="intent-audit-row"
                  :class="[`is-${row.record.status}`, { selected: selectedAuditRecord?.id === row.record.id }]"
                >
                  <button
                    class="audit-open-button"
                    type="button"
                    :aria-label="`Open audit event ${row.record.input}`"
                    @click="selectAuditRecord(row.record)"
                  >
                    <span class="audit-status">
                      {{ formatAuditStatus(row.record.status) }}
                      <em v-if="row.count > 1">x{{ row.count }}</em>
                    </span>
                    <strong>{{ row.record.input }}</strong>
                    <small>
                      {{ row.record.toolName || row.record.appKind || 'Hermes fallback' }} · {{ formatAuditTime(row.record.timestamp) }}
                    </small>
                  </button>
                </li>
              </ol>
            </section>
          </div>
        </section>

        <div class="demo-footer">
          <NButton size="small" secondary @click="memoryQueueStore.openReviewQueue">
            Memory Queue
          </NButton>
          <NButton size="small" type="warning" @click="startBuildDemo">
            Build Demo
          </NButton>
        </div>
      </section>
      </template>
    </aside>
  </Transition>

  <Transition name="audit-detail">
    <aside
      v-if="appStore.isAuroraStatusOpen && selectedAuditRecord"
      class="intent-audit-detail-drawer"
      aria-label="Intent Audit Event Detail"
    >
      <header>
        <div>
          <p>Audit Event</p>
          <h2>{{ selectedAuditRecord.input }}</h2>
        </div>
        <div class="audit-detail-actions">
            <NButton
              v-if="isMiroFishDecisionAudit(selectedAuditRecord)"
              secondary
              size="tiny"
              @click="replayMiroFishArena(selectedAuditRecord)"
            >
              Replay Arena
            </NButton>
            <NButton
              secondary
              size="tiny"
              :loading="replayingAuditRecordId === selectedAuditRecord.id"
              @click="replayAuditRecord(selectedAuditRecord)"
            >
              Replay Intent
            </NButton>
          <NButton quaternary size="tiny" @click="selectedAuditRecord = null">
            Close
          </NButton>
        </div>
      </header>

      <section class="audit-detail-grid">
        <article>
          <span>Status</span>
          <strong>{{ formatAuditStatus(selectedAuditRecord.status) }}</strong>
        </article>
        <article>
          <span>Decision</span>
          <strong>{{ auditDecision(selectedAuditRecord) }}</strong>
        </article>
        <article>
          <span>Route</span>
          <strong>{{ auditRouteLabel(selectedAuditRecord) }}</strong>
        </article>
        <article>
          <span>Security</span>
          <strong>{{ selectedAuditRecord.securityLevel || 'L1/Fallback' }}</strong>
        </article>
      </section>

      <section class="audit-detail-summary">
        <span>Summary</span>
        <p>{{ selectedAuditRecord.summary || 'No summary captured.' }}</p>
      </section>

      <section
        v-if="isGovernanceAudit(selectedAuditRecord)"
        class="audit-governance-card"
        aria-label="Governance Payload Summary"
      >
        <header>
          <div>
            <span>Governance Payload</span>
            <strong>{{ auditPayloadField(selectedAuditRecord, 'source') }}</strong>
          </div>
          <em>{{ auditDecision(selectedAuditRecord) }}</em>
        </header>

        <div class="audit-governance-grid">
          <article>
            <span>Context</span>
            <strong>{{ auditPayloadShort(selectedAuditRecord, 'contextKey', 72) }}</strong>
          </article>
          <article>
            <span>Requested</span>
            <strong>{{ auditPayloadShort(selectedAuditRecord, 'requestedAt', 72) }}</strong>
          </article>
          <article>
            <span>Decision</span>
            <strong>{{ auditPayloadShort(selectedAuditRecord, 'decisionAt', 72) }}</strong>
          </article>
          <article>
            <span>Tool</span>
            <strong>{{ selectedAuditRecord.toolName || 'n/a' }}</strong>
          </article>
        </div>

        <div class="audit-governance-command">
          <span>Reviewed Payload</span>
          <code>{{ auditPayloadShort(selectedAuditRecord, 'details', 320) }}</code>
        </div>
      </section>

      <section class="audit-detail-payload">
        <details>
          <summary>Full Payload JSON</summary>
          <pre>{{ auditPayloadJson(selectedAuditRecord) }}</pre>
        </details>
      </section>
    </aside>
  </Transition>
</template>

<style scoped lang="scss">
.aurora-status-panel {
  position: fixed;
  top: 68px;
  left: 18px;
  z-index: 1650;
  display: flex;
  width: min(390px, calc(100vw - 36px));
  max-height: calc(100vh - 88px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 22px;
  color: rgba(226, 232, 240, 0.94);
  background:
    radial-gradient(circle at 18% 0%, rgba(99, 102, 241, 0.18), transparent 42%),
    radial-gradient(circle at 92% 18%, rgba(34, 211, 238, 0.12), transparent 36%),
    rgba(15, 23, 42, 0.62);
  box-shadow:
    0 28px 90px rgba(2, 6, 23, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(32px);
}

.aurora-status-panel.is-focus-hud {
  width: min(268px, calc(100vw - 36px));
  max-height: none;
  border-color: rgba(255, 255, 255, 0.12);
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.72), rgba(30, 41, 59, 0.46)),
    rgba(2, 6, 23, 0.38);
  box-shadow:
    0 24px 76px rgba(2, 6, 23, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(28px);
}

.aurora-status-panel :deep(.n-button),
.intent-audit-detail-drawer :deep(.n-button) {
  border: 1px solid rgba(129, 140, 248, 0.34) !important;
  border-radius: 999px !important;
  color: rgba(199, 210, 254, 0.95) !important;
  background: rgba(99, 102, 241, 0.12) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 22px rgba(99, 102, 241, 0.08);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.aurora-status-panel :deep(.n-button:hover),
.intent-audit-detail-drawer :deep(.n-button:hover) {
  border-color: rgba(165, 180, 252, 0.56) !important;
  color: rgba(238, 242, 255, 0.98) !important;
  background: rgba(99, 102, 241, 0.2) !important;
  box-shadow: 0 0 26px rgba(99, 102, 241, 0.18);
}

.aurora-status-panel :deep(.n-button--disabled),
.intent-audit-detail-drawer :deep(.n-button--disabled) {
  opacity: 0.42;
  box-shadow: none;
}

.aurora-status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 60px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.focus-hud-header {
  min-height: 54px;
  padding: 11px 12px;
}

.aurora-status-header p,
.demo-path-header p,
.command-coverage header p {
  margin: 0 0 4px;
  color: rgba(148, 163, 184, 0.86);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.aurora-status-header h2 {
  margin: 0;
  color: rgba(248, 250, 252, 0.96);
  font-size: 16px;
  font-weight: 850;
  line-height: 1.2;
}

.focus-hud-grid {
  display: grid;
  gap: 7px;
  padding: 10px 12px 12px;
}

.focus-hud-cell {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
}

.focus-hud-cell span {
  color: rgba(148, 163, 184, 0.82);
  font-size: 9px;
  font-weight: 900;
  line-height: 1.1;
  text-transform: uppercase;
}

.focus-hud-cell strong {
  overflow: hidden;
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-hud-cell.is-good {
  border-color: rgba(52, 211, 153, 0.22);
}

.focus-hud-cell.is-warn {
  border-color: rgba(245, 158, 11, 0.26);
}

.focus-hud-cell.is-danger {
  border-color: rgba(248, 113, 113, 0.28);
}

.focus-hud-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.focus-hud-footer span,
.focus-hud-footer strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-hud-footer span {
  color: rgba(148, 163, 184, 0.82);
  font-size: 10px;
  font-weight: 850;
  text-transform: uppercase;
}

.focus-hud-footer strong {
  color: rgba(165, 180, 252, 0.94);
  font-size: 11px;
  font-weight: 950;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px;
}

.status-cell {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.025)),
    rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.status-cell span {
  color: rgba(148, 163, 184, 0.86);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.1;
  text-transform: uppercase;
}

.status-cell strong {
  overflow: hidden;
  color: rgba(226, 232, 240, 0.92);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 13px;
  font-weight: 850;
  line-height: 1.2;
  text-overflow: ellipsis;
  text-shadow: 0 0 18px rgba(125, 211, 252, 0.2);
  white-space: nowrap;
}

.status-cell.is-good {
  border-color: rgba(34, 211, 238, 0.18);
}

.status-cell.is-warn {
  border-color: rgba(245, 158, 11, 0.24);
}

.status-cell.is-danger {
  border-color: rgba(248, 113, 113, 0.28);
}

.neural-events-panel {
  display: grid;
  gap: 9px;
  margin: 0 12px 12px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background:
    radial-gradient(circle at 0% 0%, rgba(129, 140, 248, 0.14), transparent 42%),
    rgba(255, 255, 255, 0.035);
}

.neural-events-panel header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.neural-events-panel header p {
  margin: 0 0 4px;
  color: rgba(148, 163, 184, 0.86);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.neural-events-panel header strong {
  display: block;
  color: rgba(165, 180, 252, 0.94);
  font-size: 11px;
  font-weight: 900;
  line-height: 1.2;
}

.neural-actions {
  display: inline-flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}

.working-memory-card {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr);
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  padding: 9px;
  border: 1px solid rgba(52, 211, 153, 0.18);
  border-radius: 12px;
  background: rgba(16, 185, 129, 0.055);
}

.working-memory-card.paused {
  border-color: rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.055);
}

.memory-lock-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: #34d399;
  box-shadow: 0 0 14px rgba(52, 211, 153, 0.76);
}

.working-memory-card.paused .memory-lock-dot {
  background: #fbbf24;
  box-shadow: 0 0 14px rgba(251, 191, 36, 0.66);
}

.working-memory-card div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.working-memory-card strong,
.working-memory-card p {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.working-memory-card strong {
  color: rgba(226, 232, 240, 0.94);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  white-space: nowrap;
}

.working-memory-card p {
  display: -webkit-box;
  margin: 0;
  color: rgba(148, 163, 184, 0.82);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.neural-event-list {
  display: grid;
  gap: 0;
  max-height: 180px;
  margin: 0;
  overflow: auto;
  padding: 0;
  list-style: none;
}

.neural-event-row {
  display: grid;
  grid-template-columns: minmax(92px, 0.72fr) minmax(0, 1fr) auto;
  gap: 8px;
  min-width: 0;
  padding: 7px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  align-items: center;
}

.neural-event-row:last-child {
  border-bottom: 0;
}

.neural-event-row span,
.neural-event-row strong,
.neural-event-row time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.neural-event-row span {
  color: #c4b5fd;
  font-size: 9px;
  font-weight: 950;
  line-height: 1;
}

.neural-event-row strong {
  color: rgba(226, 232, 240, 0.9);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.2;
}

.neural-event-row time,
.neural-event-empty {
  color: rgba(148, 163, 184, 0.72);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.2;
}

.neural-event-empty {
  margin: 0;
}

.demo-path {
  display: grid;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding: 0 12px 12px;
}

.demo-path-header,
.demo-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.demo-actions,
.demo-footer {
  flex-wrap: wrap;
}

.demo-step-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.demo-step {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 12px;
  align-items: center;
  gap: 9px;
  min-height: 50px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
}

.demo-index {
  color: rgba(148, 163, 184, 0.82);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  font-weight: 850;
}

.demo-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.demo-copy strong,
.demo-copy small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-copy strong {
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  line-height: 1.15;
}

.demo-copy small {
  color: rgba(148, 163, 184, 0.72);
  font-size: 10px;
  line-height: 1.25;
}

.demo-dot {
  width: 9px;
  height: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.demo-step.is-complete .demo-dot {
  border-color: #34d399;
  background: #34d399;
  box-shadow: 0 0 12px rgba(52, 211, 153, 0.52);
}

.demo-step.is-ready .demo-dot {
  border-color: #2bd1ff;
  background: #2bd1ff;
}

.command-coverage {
  display: grid;
  gap: 9px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(34, 211, 238, 0.04)),
    rgba(255, 255, 255, 0.035);
}

.command-coverage header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.command-coverage header p {
  display: grid;
  gap: 3px;
  margin: 0;
}

.command-coverage header p span {
  color: rgba(165, 180, 252, 0.9);
  font-size: 9px;
  font-weight: 900;
}

.command-coverage header strong {
  flex: 0 0 auto;
  color: #a5b4fc;
  font-size: 18px;
  font-weight: 950;
  letter-spacing: 0;
  line-height: 1;
}

.coverage-meter {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.coverage-meter span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #7c6dff, #2bd1ff);
  box-shadow: 0 0 16px rgba(121, 99, 255, 0.32);
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.coverage-list {
  display: grid;
  gap: 7px;
  max-height: 360px;
  margin: 0;
  overflow: auto;
  padding: 0;
  list-style: none;
}

.coverage-row {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: 9px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
}

.coverage-main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.coverage-status {
  width: max-content;
  padding: 3px 6px;
  border-radius: 999px;
  border: 1px solid rgba(16, 185, 129, 0.28);
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.08);
  font-size: 9px;
  font-weight: 950;
  line-height: 1;
  text-transform: uppercase;
}

.coverage-row.is-partial .coverage-status {
  border-color: rgba(245, 158, 11, 0.3);
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.08);
}

.coverage-row.is-legacy .coverage-status {
  border-color: rgba(139, 92, 246, 0.32);
  color: #c4b5fd;
  background: rgba(139, 92, 246, 0.08);
}

.coverage-main strong,
.coverage-main small,
.coverage-action code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.coverage-main strong {
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.15;
}

.coverage-main small {
  color: rgba(148, 163, 184, 0.74);
  font-size: 10px;
  font-weight: 750;
  line-height: 1.25;
}

.coverage-meta,
.coverage-action {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.coverage-meta {
  flex-wrap: wrap;
}

.coverage-meta span {
  min-width: 0;
  padding: 4px 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  color: rgba(203, 213, 225, 0.74);
  background: rgba(255, 255, 255, 0.05);
  font-size: 9px;
  font-weight: 850;
  line-height: 1;
}

.coverage-action {
  justify-content: space-between;
}

.coverage-action code {
  flex: 1 1 auto;
  padding: 7px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: rgba(203, 213, 225, 0.82);
  background: rgba(2, 6, 23, 0.22);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
}

.intent-audit {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.035);
}

.intent-audit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.intent-audit-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.intent-audit-header p,
.intent-audit-empty {
  margin: 0;
  color: rgba(148, 163, 184, 0.82);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.intent-audit-header p {
  display: grid;
  gap: 3px;
}

.intent-audit-header p span {
  color: rgba(165, 180, 252, 0.9);
  font-size: 9px;
  font-weight: 900;
}

.intent-audit-search {
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  color: rgba(248, 250, 252, 0.92);
  background: rgba(0, 0, 0, 0.2);
  outline: none;
  font-size: 12px;
  font-weight: 750;
  transition: all var(--aurora-ease, 0.3s cubic-bezier(0.2, 0, 0, 1));
}

.intent-audit-search::placeholder {
  color: rgba(100, 116, 139, 0.86);
}

.intent-audit-search:focus {
  border-color: rgba(99, 102, 241, 0.46);
  background: rgba(2, 6, 23, 0.28);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.13), 0 0 28px rgba(99, 102, 241, 0.12);
}

.intent-audit-filters {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 5px;
}

.intent-audit-filters button {
  display: grid;
  min-width: 0;
  gap: 3px;
  padding: 7px 5px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  color: rgba(203, 213, 225, 0.72);
  background: rgba(255, 255, 255, 0.035);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.intent-audit-filters button:hover,
.intent-audit-filters button.active {
  border-color: rgba(129, 140, 248, 0.42);
  color: #c4b5fd;
  background: rgba(129, 140, 248, 0.1);
}

.intent-audit-filters button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(97, 80, 220, 0.14);
}

.intent-audit-filters span,
.intent-audit-filters strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.intent-audit-filters span {
  font-size: 9px;
  font-weight: 900;
  line-height: 1;
}

.intent-audit-filters strong {
  font-size: 11px;
  font-weight: 950;
  line-height: 1;
}

.intent-audit-file {
  display: none;
}

.intent-audit-timeline {
  display: grid;
  gap: 8px;
}

.intent-audit-day {
  display: grid;
  gap: 6px;
}

.intent-audit-day h3 {
  margin: 0;
  color: rgba(148, 163, 184, 0.66);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0;
  line-height: 1.1;
  text-transform: uppercase;
}

.intent-audit-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.intent-audit-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 0;
  background: transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.intent-audit-row:last-child {
  border-bottom: 0;
}

.intent-audit-row:hover,
.intent-audit-row.selected {
  background: rgba(255, 255, 255, 0.05);
  box-shadow: none;
}

.intent-audit-row.selected {
  box-shadow: inset 3px 0 0 rgba(129, 140, 248, 0.72);
}

.audit-open-button {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 3px;
  padding: 8px;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
}

.audit-open-button:focus-visible {
  border-radius: 10px;
  box-shadow: 0 0 0 3px rgba(129, 140, 248, 0.16);
}

.audit-status {
  display: inline-flex;
  align-items: center;
  width: max-content;
  gap: 5px;
  padding: 0;
  border-radius: 0;
  color: #c4b5fd;
  background: transparent;
  font-size: 9px;
  font-weight: 900;
  line-height: 1;
  text-transform: uppercase;
}

.audit-status::before {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 12px currentColor;
  content: "";
}

.audit-status em {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.72;
}

.intent-audit-row strong,
.intent-audit-row small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.intent-audit-row strong {
  color: rgba(226, 232, 240, 0.92);
  font-size: 11px;
  font-weight: 850;
  line-height: 1.2;
}

.intent-audit-row small {
  color: rgba(148, 163, 184, 0.72);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
}

.intent-audit-row.is-failed .audit-status,
.intent-audit-row.is-rejected .audit-status {
  color: #fca5a5;
  background: transparent;
}

.intent-audit-row.is-approval_required .audit-status {
  color: #fbbf24;
  background: transparent;
}

.intent-audit-row.is-approval_queued .audit-status {
  color: #c4b5fd;
  background: transparent;
}

.intent-audit-row.is-approval_approved .audit-status {
  color: #6ee7b7;
  background: transparent;
}

.intent-audit-row.is-approval_rejected .audit-status,
.intent-audit-row.is-approval_expired .audit-status {
  color: #fca5a5;
  background: transparent;
}

.intent-audit-detail-drawer {
  position: fixed;
  top: 68px;
  left: min(426px, calc(100vw - 470px));
  z-index: 1660;
  display: grid;
  width: min(430px, calc(100vw - 36px));
  max-height: calc(100vh - 88px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 22px;
  color: rgba(226, 232, 240, 0.94);
  background:
    radial-gradient(circle at 100% 0%, rgba(99, 102, 241, 0.16), transparent 42%),
    rgba(15, 23, 42, 0.68);
  box-shadow:
    0 28px 90px rgba(2, 6, 23, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(32px);
}

.intent-audit-detail-drawer > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 14px 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.audit-detail-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.intent-audit-detail-drawer header p,
.audit-detail-summary span,
.audit-detail-payload span,
.audit-detail-grid span {
  margin: 0;
  color: rgba(148, 163, 184, 0.82);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-transform: uppercase;
}

.intent-audit-detail-drawer header h2 {
  display: -webkit-box;
  margin: 4px 0 0;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.96);
  font-size: 16px;
  font-weight: 850;
  line-height: 1.25;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.audit-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px 12px 0;
}

.audit-detail-grid article,
.audit-detail-summary,
.audit-governance-card,
.audit-detail-payload {
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.05);
}

.audit-detail-grid article {
  display: grid;
  gap: 5px;
  padding: 10px;
}

.audit-detail-grid strong {
  overflow: hidden;
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  font-weight: 850;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-detail-summary,
.audit-detail-payload {
  display: grid;
  gap: 8px;
  margin: 10px 12px 0;
  padding: 10px;
}

.audit-governance-card {
  display: grid;
  gap: 10px;
  margin: 10px 12px 0;
  padding: 11px;
  border-color: rgba(129, 140, 248, 0.2);
  background:
    linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(34, 211, 238, 0.04)),
    rgba(255, 255, 255, 0.05);
}

.audit-governance-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.audit-governance-card header div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.audit-governance-card header strong,
.audit-governance-grid strong {
  min-width: 0;
  overflow: hidden;
  color: rgba(226, 232, 240, 0.92);
  font-size: 12px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-governance-card em {
  flex: 0 0 auto;
  padding: 4px 7px;
  border-radius: 999px;
  color: #167a4a;
  background: rgba(16, 185, 129, 0.1);
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  line-height: 1;
}

.audit-governance-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.audit-governance-grid article {
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}

.audit-governance-command {
  display: grid;
  gap: 5px;
}

.audit-governance-command code {
  max-height: 104px;
  overflow: auto;
  padding: 9px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: rgba(226, 232, 240, 0.88);
  background: rgba(2, 6, 23, 0.24);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.audit-detail-summary p {
  margin: 0;
  color: rgba(203, 213, 225, 0.82);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.45;
}

.audit-detail-payload {
  margin-bottom: 12px;
  min-height: 0;
  overflow: hidden;
}

.audit-detail-payload summary {
  color: rgba(203, 213, 225, 0.74);
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  line-height: 1.2;
}

.audit-detail-payload pre {
  max-height: min(42vh, 330px);
  margin: 9px 0 0;
  overflow: auto;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: rgba(226, 232, 240, 0.86);
  background: rgba(2, 6, 23, 0.26);
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 10px;
  font-weight: 650;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.aurora-status-enter-active,
.aurora-status-leave-active,
.audit-detail-enter-active,
.audit-detail-leave-active {
  transition: all var(--aurora-ease, 0.3s cubic-bezier(0.2, 0, 0, 1));
}

.aurora-status-enter-from,
.aurora-status-leave-to,
.audit-detail-enter-from,
.audit-detail-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 860px) {
  .intent-audit-detail-drawer {
    top: auto;
    right: 18px;
    bottom: 18px;
    left: 18px;
    width: auto;
    max-height: min(72vh, 620px);
  }
}

@media (max-width: 520px) {
  .audit-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .intent-audit-filters {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .audit-governance-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

:global(.dark) .aurora-status-panel,
:global(.dark) .intent-audit-detail-drawer {
  color: #edf3ff;
}

:global(.dark) .aurora-status-panel.is-focus-hud {
  border-color: rgba(255, 255, 255, 0.12);
  background:
    linear-gradient(135deg, rgba(29, 35, 48, 0.84), rgba(17, 21, 31, 0.62)),
    rgba(18, 22, 32, 0.6);
}

:global(.dark) .aurora-status-header,
:global(.dark) .status-cell,
:global(.dark) .focus-hud-cell,
:global(.dark) .demo-step,
:global(.dark) .command-coverage,
:global(.dark) .coverage-row,
:global(.dark) .intent-audit,
:global(.dark) .intent-audit-search,
:global(.dark) .intent-audit-row,
:global(.dark) .intent-audit-detail-drawer > header,
:global(.dark) .audit-detail-grid article,
:global(.dark) .audit-detail-summary,
:global(.dark) .audit-governance-card,
:global(.dark) .audit-detail-payload,
:global(.dark) .audit-detail-payload pre {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .intent-audit-filters button,
:global(.dark) .coverage-meta span,
:global(.dark) .coverage-action code,
:global(.dark) .audit-governance-grid article,
:global(.dark) .audit-governance-command code {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
}

:global(.dark) .intent-audit-filters button:hover,
:global(.dark) .intent-audit-filters button.active {
  border-color: rgba(157, 143, 255, 0.3);
  color: #c6bdff;
  background: rgba(255, 255, 255, 0.1);
}

:global(.dark) .intent-audit-row:hover,
:global(.dark) .intent-audit-row.selected {
  border-color: rgba(157, 143, 255, 0.3);
  background: rgba(255, 255, 255, 0.1);
}

:global(.dark) .aurora-status-header h2,
:global(.dark) .status-cell strong,
:global(.dark) .focus-hud-cell strong,
:global(.dark) .demo-copy strong,
:global(.dark) .command-coverage header strong,
:global(.dark) .coverage-main strong,
:global(.dark) .intent-audit-row strong,
:global(.dark) .intent-audit-detail-drawer header h2,
:global(.dark) .audit-detail-grid strong,
:global(.dark) .audit-governance-card header strong,
:global(.dark) .audit-governance-grid strong {
  color: #edf3ff;
}

:global(.dark) .aurora-status-header p,
:global(.dark) .focus-hud-footer span,
:global(.dark) .demo-path-header p,
:global(.dark) .command-coverage header p,
:global(.dark) .status-cell span,
:global(.dark) .focus-hud-cell span,
:global(.dark) .demo-index,
:global(.dark) .demo-copy small,
:global(.dark) .coverage-main small,
:global(.dark) .coverage-meta span,
:global(.dark) .intent-audit-header p,
:global(.dark) .intent-audit-empty,
:global(.dark) .intent-audit-day h3,
:global(.dark) .intent-audit-row small,
:global(.dark) .intent-audit-detail-drawer header p,
:global(.dark) .audit-detail-summary span,
:global(.dark) .audit-detail-payload span,
:global(.dark) .audit-detail-payload summary,
:global(.dark) .audit-detail-grid span,
:global(.dark) .audit-governance-card span {
  color: rgba(237, 243, 255, 0.56);
}

:global(.dark) .intent-audit-search,
:global(.dark) .coverage-action code,
:global(.dark) .audit-detail-summary p,
:global(.dark) .audit-detail-payload pre,
:global(.dark) .audit-governance-command code {
  color: rgba(237, 243, 255, 0.86);
}
</style>
