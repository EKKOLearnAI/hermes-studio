<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  getQuantLabEvidenceArchives,
  getQuantLabAuditSnapshots,
  runQuantLabMiroFish,
  saveQuantLabReport,
  toMiroFishSafeErrorMessage,
  type QuantLabAuditSnapshotEntry,
  type QuantLabEvidenceArchiveEntry,
  type QuantLabBriefPhase,
  type QuantLabMiroFishDebateArgument,
  type QuantLabTopPick,
  type RunQuantLabMiroFishResult,
} from '@/api/hermes/quant-lab'
import { useAuroraIntentAuditStore, type AuroraIntentAuditRecord } from '@/stores/hermes/aurora-intent-audit'

type AgentTone = 'macro' | 'bull' | 'bear'
type ArenaFocusPath = AgentTone | 'verdict'
type ScenarioKey = 'base' | 'bull-shock' | 'bear-shock' | 'macro-stress'

interface ArenaAgentCard {
  key: AgentTone
  icon: string
  name: string
  stance: string
  score: string
  confidence: string
  content: string
  reasoningBullets: ReasoningBullet[]
  points: string[]
}

interface ReasoningSegment {
  text: string
  highlight: boolean
}

interface ReasoningBullet {
  key: string
  segments: ReasoningSegment[]
}

interface VerdictScenarioCard {
  key: 'bullish' | 'neutral' | 'bearish'
  label: string
  probability: string
  confidence: string
  reasoning: string
}

type ReplayTone = AgentTone | 'synth'

interface ArchiveReplayCard {
  key: ReplayTone
  icon: string
  label: string
  title: string
  content: string
  meta: string
}

type CompareTone = 'aligned' | 'watch' | 'risk' | 'neutral'

interface ArchiveCompareRow {
  key: string
  label: string
  current: string
  archive: string
  tone: CompareTone
}

interface ReplayDeltaBadge {
  key: string
  label: string
  current: string
  archive: string
  tone: CompareTone
}

interface DecisionTimelineItem {
  id: string
  timestamp: string
  currentSignal: string
  currentAction: string
  archiveAction: string
  archiveTitle: string
  riskMultiplier: string
  driftScoreLabel: string
  tone: CompareTone
  summary: string
}

interface BaselineDriftAlert {
  key: string
  title: string
  detail: string
  tone: CompareTone
}

interface BaselineDriftScore {
  score: number
  label: 'Low' | 'Medium' | 'High'
  tone: CompareTone
  detail: string
}

interface BaselineDriftContribution {
  key: string
  label: string
  points: number
  tone: CompareTone
  reason: string
  current: string
  baseline: string
}

interface ScenarioPreset {
  key: ScenarioKey
  label: string
  badge: string
  phase: QuantLabBriefPhase
  riskDelta: number
  description: string
  thesis: string
}

interface ScenarioMatrixRow {
  key: ScenarioKey
  label: string
  badge: string
  action: 'BUY' | 'SELL' | 'HOLD'
  actionTone: 'buy' | 'sell' | 'hold'
  riskMultiplier: string
  riskDeltaLabel: string
  bullProbability: string
  bearProbability: string
  confidence: string
  thesis: string
}

interface ScenarioDrilldownPoint {
  key: string
  tone: AgentTone
  label: string
  value: string
  delta: string
  detail: string
}

interface ScenarioMatrixDrilldown {
  row: ScenarioMatrixRow
  summary: string
  points: ScenarioDrilldownPoint[]
}

interface AuditSnapshotCompareRow {
  label: string
  current: string
  baseline: string
  tone: 'aligned' | 'changed' | 'risk'
  detail: string
}

interface CsvPreviewTable {
  headers: string[]
  rows: string[][]
  totalRows: number
}

type CsvPreviewSortDirection = 'asc' | 'desc'

interface AuditGalleryStoredState {
  query: string
  category: AuditGalleryFilter
  action: AuditGalleryActionFilter
  drift: AuditGalleryDriftFilter
  date: AuditGalleryDateFilter
  selectedFile: string
}

interface AuditGalleryPortableState extends AuditGalleryStoredState {
  version: 1
  hiddenFiles: string[]
  pinnedFile: string
}

type BatchExportFormat = 'markdown' | 'csv'
type AuditGalleryFilter = 'all' | 'audit' | 'batch' | 'compare'
type AuditGalleryActionFilter = 'all' | 'buy' | 'hold' | 'sell' | 'watch'
type AuditGalleryDriftFilter = 'all' | 'stable' | 'changed' | 'high'
type AuditGalleryDateFilter = 'all' | 'today' | 'week'

interface QuantRiskBridgeBatchResult {
  ticker: string
  action: string
  score: string
  risk: string
  confidence: string
  riskMultiplier: string
  status: 'queued' | 'running' | 'complete' | 'failed'
  summary: string
}

interface QuantRiskBridgeLaunchContext {
  source: 'aurora-omnibar' | 'aurora-memory-stream' | 'quant-risk-bridge' | 'quant-risk-bridge-batch'
  targetTicker?: string
  topic?: string
  memoryRecordId?: string
  memoryRecordPath?: string
  pick?: Partial<QuantLabTopPick>
  batchPicks?: Partial<QuantLabTopPick>[]
  batchLimit?: number
  snapshotSource?: string
  snapshotGeneratedAt?: string
  decision?: {
    action?: string
    conclusion?: string
    invalidation?: string
  }
  marketPulse?: Array<{ label: string; value: string; tone?: string }>
}

const props = defineProps<{
  replayRecord?: AuroraIntentAuditRecord | null
  launchContext?: QuantRiskBridgeLaunchContext | null
}>()

const emit = defineEmits<{
  focusPath: [path: ArenaFocusPath]
  resultChange: [result: RunQuantLabMiroFishResult | null]
}>()

const PIN_STORAGE_KEY = 'aurora.mirofish.pinned-decision.v1'
const SNAPSHOT_PIN_STORAGE_KEY = 'aurora.mirofish.pinned-audit-snapshot.v1'
const GALLERY_STATE_STORAGE_KEY = 'aurora.mirofish.audit-gallery-state.v1'
const GALLERY_HIDDEN_STORAGE_KEY = 'aurora.mirofish.hidden-gallery-entries.v1'
const scenarioPresets: ScenarioPreset[] = [
  {
    key: 'base',
    label: 'Base',
    badge: 'Live sandbox',
    phase: 'premarket',
    riskDelta: 0,
    description: 'Use the raw MiroFish sandbox inference without extra stress.',
    thesis: 'Baseline follows the current Macro, Bull, Bear debate.',
  },
  {
    key: 'bull-shock',
    label: 'Bull Shock',
    badge: 'Upside',
    phase: 'premarket',
    riskDelta: -0.12,
    description: 'Assume breakout confirmation, liquidity support, and lower volatility.',
    thesis: 'Upside pressure improves execution confidence while tightening risk.',
  },
  {
    key: 'bear-shock',
    label: 'Bear Shock',
    badge: 'Drawdown',
    phase: 'premarket',
    riskDelta: 0.35,
    description: 'Assume failed breakout, valuation compression, and risk-off breadth.',
    thesis: 'Downside pressure flips the sandbox verdict into protection mode.',
  },
  {
    key: 'macro-stress',
    label: 'Macro Stress',
    badge: 'Regime',
    phase: 'afterclose',
    riskDelta: 0.22,
    description: 'Assume liquidity drain, policy uncertainty, and wider volatility.',
    thesis: 'Macro pressure lowers conviction and favors reduced exposure.',
  },
]
const scenarioProbabilityDeltas: Record<ScenarioKey, { bullish: number; bearish: number }> = {
  base: { bullish: 0, bearish: 0 },
  'bull-shock': { bullish: 0.12, bearish: -0.08 },
  'bear-shock': { bullish: -0.16, bearish: 0.2 },
  'macro-stress': { bullish: -0.08, bearish: 0.11 },
}
const storedAuditGalleryState = readAuditGalleryState()
const loading = ref(false)
const archiveLoading = ref(false)
const error = ref('')
const archiveError = ref('')
const result = ref<RunQuantLabMiroFishResult | null>(null)
const archives = ref<QuantLabEvidenceArchiveEntry[]>([])
const selectedArchiveId = ref('')
const activeScenarioKey = ref<ScenarioKey>('base')
const activeScenarioDrilldownKey = ref<ScenarioKey>('base')
const pinnedDecisionId = ref(readPinnedDecisionId())
const baselineDrilldownOpen = ref(false)
const auditExporting = ref(false)
const auditExportStatus = ref('')
const auditExportPath = ref('')
const auditExportError = ref('')
const auditCompareExporting = ref(false)
const auditCompareExportStatus = ref('')
const auditCompareExportPath = ref('')
const auditCompareExportError = ref('')
const auditGalleryOpen = ref(false)
const auditGalleryLoading = ref(false)
const auditGalleryError = ref('')
const auditSnapshots = ref<QuantLabAuditSnapshotEntry[]>([])
const auditGalleryQuery = ref(storedAuditGalleryState.query)
const auditGalleryFilter = ref<AuditGalleryFilter>(storedAuditGalleryState.category)
const auditGalleryActionFilter = ref<AuditGalleryActionFilter>(storedAuditGalleryState.action)
const auditGalleryDriftFilter = ref<AuditGalleryDriftFilter>(storedAuditGalleryState.drift)
const auditGalleryDateFilter = ref<AuditGalleryDateFilter>(storedAuditGalleryState.date)
const auditGallerySyncOpen = ref(false)
const auditGallerySyncText = ref('')
const auditGallerySyncStatus = ref('')
const auditGallerySyncError = ref('')
const selectedAuditSnapshotFile = ref(storedAuditGalleryState.selectedFile)
const compareAuditSnapshotFile = ref('')
const pinnedAuditSnapshotFile = ref(readPinnedAuditSnapshotFile())
const hiddenAuditSnapshotFiles = ref(readHiddenAuditSnapshotFiles())
const auditGalleryRegion = ref<HTMLElement | null>(null)
const csvPreviewSortHeader = ref('')
const csvPreviewSortDirection = ref<CsvPreviewSortDirection>('asc')
const activeBatchTicker = ref('')
const batchRunning = ref(false)
const batchError = ref('')
const batchResults = ref<QuantRiskBridgeBatchResult[]>([])
const batchExporting = ref<BatchExportFormat | ''>('')
const batchExportStatus = ref('')
const batchExportPath = ref('')
const batchExportError = ref('')
const revealStage = ref(0)
const advancedSettingsOpen = ref(false)
const galleryReplayRecord = ref<AuroraIntentAuditRecord | null>(null)
const auditedComparisonKeys = new Set<string>()
const auditedComparisonRecordIds = new Map<string, string>()
const driftAuditSignatures = new Map<string, string>()

watch(result, nextResult => {
  emit('resultChange', nextResult)
}, { immediate: true })
let revealTimer: number | null = null
const intentAuditStore = useAuroraIntentAuditStore()

const inference = computed(() => result.value?.mirofish.inference || null)
const debate = computed(() => inference.value?.debate || null)
const topPick = computed(() => result.value?.topPicks?.[0] || null)
const replayAuditRecord = computed(() => galleryReplayRecord.value || props.replayRecord || null)
const isAuditReplay = computed(() => Boolean(replayAuditRecord.value))
const visibleAuditSnapshots = computed(() =>
  auditSnapshots.value.filter(entry => !hiddenAuditSnapshotFiles.value.includes(entry.fileName)),
)
const selectedAuditSnapshot = computed(() =>
  visibleAuditSnapshots.value.find(entry => entry.fileName === selectedAuditSnapshotFile.value) || visibleAuditSnapshots.value[0] || null,
)
const pinnedAuditSnapshot = computed(() =>
  auditSnapshots.value.find(entry => entry.fileName === pinnedAuditSnapshotFile.value && isAuditSnapshotEntry(entry)) || null,
)
const comparisonAuditSnapshot = computed(() => {
  const selected = selectedAuditSnapshot.value
  if (!selected || !isAuditSnapshotEntry(selected)) return null
  const explicit = auditSnapshots.value.find(entry =>
    entry.fileName === compareAuditSnapshotFile.value && entry.fileName !== selected.fileName && isAuditSnapshotEntry(entry),
  )
  if (explicit) return explicit
  if (pinnedAuditSnapshot.value && pinnedAuditSnapshot.value.fileName !== selected.fileName) {
    return pinnedAuditSnapshot.value
  }
  return auditSnapshots.value.find(entry => entry.fileName !== selected.fileName && isAuditSnapshotEntry(entry)) || null
})
const filteredAuditSnapshots = computed(() => {
  const query = auditGalleryQuery.value.trim().toLowerCase()
  return visibleAuditSnapshots.value.filter((entry) => {
    const category = auditEntryCategory(entry)
    if (auditGalleryFilter.value !== 'all' && category !== auditGalleryFilter.value) return false
    if (!auditEntryMatchesAction(entry, auditGalleryActionFilter.value)) return false
    if (!auditEntryMatchesDrift(entry, auditGalleryDriftFilter.value)) return false
    if (!auditEntryMatchesDate(entry, auditGalleryDateFilter.value)) return false
    if (!query) return true
    return [
      entry.fileName,
      entry.title,
      entry.summary,
      entry.signal,
      entry.categoryLabel,
      entry.relativePath,
      entry.content,
    ].some(value => String(value || '').toLowerCase().includes(query))
  })
})
const auditGalleryCounts = computed(() => ({
  all: visibleAuditSnapshots.value.length,
  audit: visibleAuditSnapshots.value.filter(entry => auditEntryCategory(entry) === 'audit').length,
  batch: visibleAuditSnapshots.value.filter(entry => auditEntryCategory(entry) === 'batch').length,
  compare: visibleAuditSnapshots.value.filter(entry => auditEntryCategory(entry) === 'compare').length,
  hidden: hiddenAuditSnapshotFiles.value.length,
}))
const selectedAuditSnapshotPreview = computed(() => {
  const content = selectedAuditSnapshot.value?.content || ''
  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('---'))
    .slice(0, 34)
    .join('\n')
})
const selectedBatchCsvPreview = computed<CsvPreviewTable | null>(() => {
  const selected = selectedAuditSnapshot.value
  if (!selected || auditEntryKind(selected) !== 'batch-csv') return null
  const table = parseCsvPreviewTable(selected.content)
  return table ? sortCsvPreviewTable(table) : null
})
const auditSnapshotCompareRows = computed<AuditSnapshotCompareRow[]>(() => {
  const current = selectedAuditSnapshot.value
  const baseline = comparisonAuditSnapshot.value
  if (!current || !baseline) return []
  const currentMetrics = auditSnapshotMetrics(current)
  const baselineMetrics = auditSnapshotMetrics(baseline)
  const riskDelta = numberFromText(currentMetrics.riskMultiplier) - numberFromText(baselineMetrics.riskMultiplier)
  const driftDelta = numberFromText(currentMetrics.driftScore) - numberFromText(baselineMetrics.driftScore)

  return [
    compareRow('Signal', currentMetrics.signal, baselineMetrics.signal, currentMetrics.signal === baselineMetrics.signal ? 'aligned' : 'changed', 'Decision signal from the exported snapshot frontmatter.'),
    compareRow('Action', currentMetrics.action, baselineMetrics.action, currentMetrics.action === baselineMetrics.action ? 'aligned' : 'risk', 'Action extracted from the Current Decision block.'),
    compareRow('Confidence', currentMetrics.confidence, baselineMetrics.confidence, currentMetrics.confidence === baselineMetrics.confidence ? 'aligned' : 'changed', 'Confidence label recorded at export time.'),
    compareRow('Risk', currentMetrics.riskMultiplier, baselineMetrics.riskMultiplier, riskDelta > 0 ? 'risk' : riskDelta === 0 ? 'aligned' : 'changed', 'Risk multiplier or risk label from the snapshot.'),
    compareRow('Drift', currentMetrics.driftScore, baselineMetrics.driftScore, driftDelta > 0 ? 'risk' : driftDelta === 0 ? 'aligned' : 'changed', 'Pinned baseline drift score captured in the replay.'),
    compareRow('Summary', currentMetrics.summary, baselineMetrics.summary, currentMetrics.summary === baselineMetrics.summary ? 'aligned' : 'changed', 'High-level replay summary for audit review.'),
  ]
})
const quantRiskBridgeContext = computed(() =>
  props.launchContext?.source === 'quant-risk-bridge' || props.launchContext?.source === 'quant-risk-bridge-batch'
    ? props.launchContext
    : null,
)
const isBatchRiskBridge = computed(() => quantRiskBridgeContext.value?.source === 'quant-risk-bridge-batch')
const bridgeBatchPicks = computed(() =>
  (quantRiskBridgeContext.value?.batchPicks || [])
    .map(pick => ({
      ...pick,
      ticker: normalizeTicker(pick.ticker),
    }))
    .filter((pick): pick is Partial<QuantLabTopPick> & { ticker: string } => Boolean(pick.ticker))
    .slice(0, Math.max(1, Math.min(6, Number(quantRiskBridgeContext.value?.batchLimit) || 3))),
)
const bridgeTargetTicker = computed(() =>
  normalizeTicker(activeBatchTicker.value || props.launchContext?.targetTicker || quantRiskBridgeContext.value?.pick?.ticker),
)
const bridgeTopic = computed(() => truncateText(cleanText(props.launchContext?.topic, ''), 220))
const debateSubject = computed(() => bridgeTargetTicker.value || bridgeTopic.value || 'market setup')
const bridgePick = computed(() =>
  bridgeBatchPicks.value.find(pick => pick.ticker === bridgeTargetTicker.value) ||
  quantRiskBridgeContext.value?.pick ||
  null,
)
const batchExportReady = computed(() =>
  isBatchRiskBridge.value &&
  !batchRunning.value &&
  batchResults.value.some(item => item.status === 'complete' || item.status === 'failed'),
)
const bridgeDecisionSummary = computed(() =>
  cleanText(
    quantRiskBridgeContext.value?.decision?.conclusion ||
      quantRiskBridgeContext.value?.decision?.action ||
      bridgePick.value?.reason,
    'Quant Lab opened this focused MiroFish risk simulation from the Top 10 candidates.',
  ),
)
const activeScenarioPreset = computed(() =>
  scenarioPresets.find(preset => preset.key === activeScenarioKey.value) || scenarioPresets[0],
)
const replayScenarioLabel = computed(() =>
  replayAuditRecord.value
    ? auditNestedString(replayAuditRecord.value, 'current', 'scenario', activeScenarioPreset.value.label)
    : activeScenarioPreset.value.label,
)
const replayArchiveLabel = computed(() =>
  replayAuditRecord.value
    ? auditNestedString(replayAuditRecord.value, 'archive', 'title', 'Selected archive')
    : 'Selected archive',
)
const replayDriftLabel = computed(() => {
  const record = replayAuditRecord.value
  if (!record) return 'Drift n/a'
  const score = auditNestedString(record, 'baselineDrift', 'score', 'n/a')
  const label = auditNestedString(record, 'baselineDrift', 'label', '')
  return `Drift ${score}/100${label ? ` ${label}` : ''}`
})
const replayBaselineLabel = computed(() =>
  replayAuditRecord.value
    ? auditNestedString(replayAuditRecord.value, 'baselineDrift', 'pinnedSignal', 'Pinned baseline')
    : 'Pinned baseline',
)
const replaySourceTags = computed(() => {
  const record = replayAuditRecord.value
  if (!record) return []
  const snapshot = record.payload?.snapshot
  const snapshotFile = isRecordObject(snapshot) && typeof snapshot.fileName === 'string'
    ? snapshot.fileName
    : ''
  const driftSource = auditNestedString(record, 'baselineDrift', 'source', '')
  const tags = [
    snapshotFile ? `Replay source ${snapshotFile}` : `Replay source ${record.toolName || 'Intent Audit'}`,
  ]
  if (driftSource) tags.push(`Baseline source ${driftSource}`)
  return tags
})
const replayDeltaBadges = computed<ReplayDeltaBadge[]>(() => {
  const deltas = replayAuditRecord.value?.payload?.deltas
  if (!Array.isArray(deltas)) return []
  return deltas
    .filter(isRecordObject)
    .map((item, index) => ({
      key: typeof item.label === 'string' ? item.label : `delta-${index}`,
      label: typeof item.label === 'string' ? item.label : 'Delta',
      current: typeof item.current === 'string' ? item.current : String(item.current ?? 'n/a'),
      archive: typeof item.archive === 'string' ? item.archive : String(item.archive ?? 'n/a'),
      tone: isCompareTone(item.tone) ? item.tone : 'neutral',
    }))
    .slice(0, 6)
})
const replayDriftContributions = computed<BaselineDriftContribution[]>(() => {
  const drift = replayAuditRecord.value?.payload?.baselineDrift
  if (!isRecordObject(drift) || !Array.isArray(drift.contributions)) return []
  return drift.contributions
    .filter(isRecordObject)
    .map((item, index) => ({
      key: typeof item.key === 'string' ? item.key : `replay-${index}`,
      label: typeof item.label === 'string' ? item.label : 'Replay factor',
      points: typeof item.points === 'number' ? item.points : 0,
      tone: isCompareTone(item.tone) ? item.tone : 'neutral',
      reason: typeof item.reason === 'string' ? item.reason : 'Replay contribution restored from audit payload.',
      current: typeof item.current === 'string' ? item.current : String(item.current ?? 'n/a'),
      baseline: typeof item.baseline === 'string' ? item.baseline : String(item.baseline ?? 'n/a'),
    }))
})
const selectedArchive = computed(() => archives.value.find(entry => entry.fileName === selectedArchiveId.value) || archives.value[0] || null)
const currentSignalLabel = computed(() => topPick.value ? `${finalAction.value} ${topPick.value.ticker}` : finalAction.value)
const currentConfidenceLabel = computed(() => archiveConfidenceLabel(inference.value?.confidence) || formatProbability(debate.value?.scenarios.bullish.confidence))
const currentTopSignalLabel = computed(() => topPick.value ? `${topPick.value.ticker} ${topPick.value.score.toFixed(1)}` : 'Pending')
const archiveReplayCards = computed<ArchiveReplayCard[]>(() => {
  const archive = selectedArchive.value
  if (!archive) return []

  const topDegree = archive.topDegrees?.[0]
  const graphState = archive.graphOk ? 'Graph ready' : 'Local graph fallback'
  const evidenceCount = archive.evidenceCount ?? 0
  const source = archive.source || archive.graphSource || 'MiroFish archive'

  return [
    {
      key: 'macro',
      icon: '🌍',
      label: 'Macro Replay',
      title: archive.phase || 'Archived regime',
      content: cleanText(
        `${graphState}. Evidence ${evidenceCount}. ${archive.summary}`,
        'Macro replay is reconstructing the archived market regime.',
      ),
      meta: `Source ${source}`,
    },
    {
      key: 'bull',
      icon: '🐂',
      label: 'Bull Replay',
      title: 'Support thesis',
      content: cleanText(archive.support, 'No support thesis was captured in this archive.'),
      meta: topDegree ? `Top degree ${topDegree.ticker} ${topDegree.degree}` : 'Top degree n/a',
    },
    {
      key: 'bear',
      icon: '🐻',
      label: 'Bear Replay',
      title: 'Risk challenge',
      content: cleanText(archive.oppose, 'No opposing thesis was captured in this archive.'),
      meta: `${archiveConfidenceLabel(archive.confidence)} · ${archive.status || 'archived'}`,
    },
    {
      key: 'synth',
      icon: 'Σ',
      label: 'Synthesizer Replay',
      title: archive.title,
      content: cleanText(archive.summary, 'Hermes Synthesizer replay is waiting for archived summary.'),
      meta: archive.relativePath,
    },
  ]
})
const archiveCompareRows = computed<ArchiveCompareRow[]>(() => {
  const archive = selectedArchive.value
  if (!archive) return []

  const archiveAction = inferArchiveAction(archive)
  const currentTopSignal = topPick.value ? `${topPick.value.ticker} ${topPick.value.score.toFixed(1)}` : 'Pending'
  const archiveTopSignal = archive.topDegrees?.[0]
    ? `${archive.topDegrees[0].ticker} degree ${archive.topDegrees[0].degree}`
    : 'n/a'

  return [
    {
      key: 'action',
      label: 'Action',
      current: currentSignalLabel.value,
      archive: archiveAction,
      tone: compareActionTone(finalAction.value, archiveAction),
    },
    {
      key: 'confidence',
      label: 'Confidence',
      current: currentConfidenceLabel.value,
      archive: archiveConfidenceLabel(archive.confidence),
      tone: confidenceTone(inference.value?.confidence, archive.confidence),
    },
    {
      key: 'risk',
      label: 'Risk Multiplier',
      current: riskMultiplier.value,
      archive: archive.graphOk ? 'Archive not captured' : 'Local graph fallback',
      tone: archive.graphOk ? 'neutral' : 'risk',
    },
    {
      key: 'top-signal',
      label: 'Top Signal',
      current: currentTopSignal,
      archive: archiveTopSignal,
      tone: topPick.value && archive.topDegrees?.[0]?.ticker === topPick.value.ticker ? 'aligned' : 'watch',
    },
  ]
})
const decisionAuditRecords = computed(() => intentAuditStore.records.filter(isMiroFishDecisionAuditRecord))
const decisionTimelineItems = computed<DecisionTimelineItem[]>(() =>
  decisionAuditRecords.value
    .slice(0, 6)
    .map(toDecisionTimelineItem),
)
const pinnedDecisionRecord = computed(() =>
  decisionAuditRecords.value.find(record => record.id === pinnedDecisionId.value) || null,
)
const pinnedDecisionItem = computed(() =>
  pinnedDecisionRecord.value ? toDecisionTimelineItem(pinnedDecisionRecord.value) : null,
)
const pinnedBaselineCompareRows = computed<ArchiveCompareRow[]>(() => {
  const pinnedRecord = pinnedDecisionRecord.value
  if (!pinnedRecord || !result.value) return []

  const pinnedAction = auditNestedString(pinnedRecord, 'current', 'action', 'HOLD')
  const pinnedSignal = auditNestedString(pinnedRecord, 'current', 'signal', 'Pinned signal pending')
  const pinnedConfidence = auditNestedString(pinnedRecord, 'current', 'confidence', 'unknown')
  const pinnedRisk = auditNestedString(pinnedRecord, 'current', 'riskMultiplier', 'n/a')
  const pinnedTopSignal = auditNestedString(pinnedRecord, 'current', 'topSignal', pinnedSignal)

  return [
    {
      key: 'pinned-action',
      label: 'Action',
      current: currentSignalLabel.value,
      archive: pinnedSignal,
      tone: compareActionTone(finalAction.value, pinnedAction),
    },
    {
      key: 'pinned-confidence',
      label: 'Confidence',
      current: currentConfidenceLabel.value,
      archive: pinnedConfidence,
      tone: confidenceTone(inference.value?.confidence, pinnedConfidence.toLowerCase()),
    },
    {
      key: 'pinned-risk',
      label: 'Risk Multiplier',
      current: riskMultiplier.value,
      archive: pinnedRisk,
      tone: compareRiskTone(riskMultiplier.value, pinnedRisk),
    },
    {
      key: 'pinned-top-signal',
      label: 'Top Signal',
      current: currentTopSignalLabel.value,
      archive: pinnedTopSignal,
      tone: currentTopSignalLabel.value === pinnedTopSignal ? 'aligned' : 'watch',
    },
  ]
})
const baselineDriftAlerts = computed<BaselineDriftAlert[]>(() =>
  pinnedBaselineCompareRows.value
    .filter(row => row.tone === 'risk' || row.tone === 'watch')
    .map(toBaselineDriftAlert),
)
const baselineDriftContributions = computed<BaselineDriftContribution[]>(() =>
  pinnedBaselineCompareRows.value.map(toBaselineDriftContribution),
)
const baselineDriftScore = computed<BaselineDriftScore>(() => {
  const rows = pinnedBaselineCompareRows.value
  if (!pinnedDecisionItem.value || rows.length === 0) {
    return {
      score: 0,
      label: 'Low',
      tone: 'neutral',
      detail: 'Pin a decision to activate drift scoring.',
    }
  }

  const score = Math.min(100, rows.reduce((total, row) => total + driftScoreWeight(row), 0))
  const label: BaselineDriftScore['label'] = score >= 70 ? 'High' : score >= 35 ? 'Medium' : 'Low'
  const tone: CompareTone = score >= 70 ? 'risk' : score > 0 ? 'watch' : 'aligned'
  const driftCount = baselineDriftAlerts.value.length

  return {
    score,
    label,
    tone,
    detail: driftCount > 0
      ? `${driftCount} weighted drift signal${driftCount === 1 ? '' : 's'} detected.`
      : 'No weighted drift signals detected.',
  }
})

function readPinnedDecisionId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function persistPinnedDecisionId(value: string) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(PIN_STORAGE_KEY, value)
    } else {
      window.localStorage.removeItem(PIN_STORAGE_KEY)
    }
  } catch {
    // Pinning is a convenience layer and must not block the sandbox.
  }
}

function readPinnedAuditSnapshotFile(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(SNAPSHOT_PIN_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function persistPinnedAuditSnapshotFile(value: string) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(SNAPSHOT_PIN_STORAGE_KEY, value)
    } else {
      window.localStorage.removeItem(SNAPSHOT_PIN_STORAGE_KEY)
    }
  } catch {
    // Snapshot pinning is local UI state and must not block audit review.
  }
}

function readHiddenAuditSnapshotFiles(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GALLERY_HIDDEN_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string' && /^mirofish-/.test(value))
      .slice(0, 120)
  } catch {
    return []
  }
}

function persistHiddenAuditSnapshotFiles(files: string[]) {
  if (typeof window === 'undefined') return
  try {
    if (files.length) {
      window.localStorage.setItem(GALLERY_HIDDEN_STORAGE_KEY, JSON.stringify(files.slice(0, 120)))
    } else {
      window.localStorage.removeItem(GALLERY_HIDDEN_STORAGE_KEY)
    }
  } catch {
    // Retention controls are local-only and must not block the review surface.
  }
}

function readAuditGalleryState(): AuditGalleryStoredState {
  const fallback: AuditGalleryStoredState = {
    query: '',
    category: 'all',
    action: 'all',
    drift: 'all',
    date: 'all',
    selectedFile: '',
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(GALLERY_STATE_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as Partial<AuditGalleryStoredState> : {}
    return {
      query: typeof parsed.query === 'string' ? parsed.query.slice(0, 160) : fallback.query,
      category: normalizeGalleryFilter(parsed.category, ['all', 'audit', 'batch', 'compare'], fallback.category),
      action: normalizeGalleryFilter(parsed.action, ['all', 'buy', 'hold', 'sell', 'watch'], fallback.action),
      drift: normalizeGalleryFilter(parsed.drift, ['all', 'stable', 'changed', 'high'], fallback.drift),
      date: normalizeGalleryFilter(parsed.date, ['all', 'today', 'week'], fallback.date),
      selectedFile: typeof parsed.selectedFile === 'string' ? parsed.selectedFile.slice(0, 180) : fallback.selectedFile,
    }
  } catch {
    return fallback
  }
}

function normalizeGalleryFilter<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

function persistAuditGalleryState() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(GALLERY_STATE_STORAGE_KEY, JSON.stringify({
      query: auditGalleryQuery.value,
      category: auditGalleryFilter.value,
      action: auditGalleryActionFilter.value,
      drift: auditGalleryDriftFilter.value,
      date: auditGalleryDateFilter.value,
      selectedFile: selectedAuditSnapshotFile.value,
    }))
  } catch {
    // Gallery memory is local convenience state and must not block audit review.
  }
}

function buildAuditGalleryPortableState(): AuditGalleryPortableState {
  return {
    version: 1,
    query: auditGalleryQuery.value,
    category: auditGalleryFilter.value,
    action: auditGalleryActionFilter.value,
    drift: auditGalleryDriftFilter.value,
    date: auditGalleryDateFilter.value,
    selectedFile: selectedAuditSnapshotFile.value,
    hiddenFiles: hiddenAuditSnapshotFiles.value,
    pinnedFile: pinnedAuditSnapshotFile.value,
  }
}

function openAuditGalleryStateSync() {
  auditGallerySyncOpen.value = !auditGallerySyncOpen.value
  auditGallerySyncStatus.value = ''
  auditGallerySyncError.value = ''
  if (auditGallerySyncOpen.value) {
    auditGallerySyncText.value = JSON.stringify(buildAuditGalleryPortableState(), null, 2)
  }
}

function applyAuditGalleryStateSync() {
  auditGallerySyncStatus.value = ''
  auditGallerySyncError.value = ''
  try {
    const parsed = JSON.parse(auditGallerySyncText.value) as Partial<AuditGalleryPortableState>
    auditGalleryQuery.value = typeof parsed.query === 'string' ? parsed.query.slice(0, 160) : ''
    auditGalleryFilter.value = normalizeGalleryFilter(parsed.category, ['all', 'audit', 'batch', 'compare'], 'all')
    auditGalleryActionFilter.value = normalizeGalleryFilter(parsed.action, ['all', 'buy', 'hold', 'sell', 'watch'], 'all')
    auditGalleryDriftFilter.value = normalizeGalleryFilter(parsed.drift, ['all', 'stable', 'changed', 'high'], 'all')
    auditGalleryDateFilter.value = normalizeGalleryFilter(parsed.date, ['all', 'today', 'week'], 'all')
    hiddenAuditSnapshotFiles.value = Array.isArray(parsed.hiddenFiles)
      ? parsed.hiddenFiles.filter((value): value is string => typeof value === 'string' && /^mirofish-/.test(value)).slice(0, 120)
      : []
    pinnedAuditSnapshotFile.value = typeof parsed.pinnedFile === 'string' ? parsed.pinnedFile : ''
    selectedAuditSnapshotFile.value = typeof parsed.selectedFile === 'string' ? parsed.selectedFile : ''
    persistHiddenAuditSnapshotFiles(hiddenAuditSnapshotFiles.value)
    persistPinnedAuditSnapshotFile(pinnedAuditSnapshotFile.value)
    persistAuditGalleryState()
    auditGallerySyncStatus.value = 'Portable state applied'
  } catch (err: any) {
    auditGallerySyncError.value = err?.message || 'Invalid Gallery state JSON.'
  }
}

function toDecisionTimelineItem(record: AuroraIntentAuditRecord): DecisionTimelineItem {
  const currentSignal = auditNestedString(record, 'current', 'signal', 'Current signal pending')
  const currentAction = auditNestedString(record, 'current', 'action', currentSignal.split(/\s+/)[0] || 'HOLD')
  const archiveAction = auditNestedString(record, 'archive', 'action', 'ARCHIVE')

  return {
    id: record.id,
    timestamp: record.timestamp,
    currentSignal,
    currentAction,
    archiveAction,
    archiveTitle: auditNestedString(record, 'archive', 'title', 'Selected archive'),
    riskMultiplier: auditNestedString(record, 'current', 'riskMultiplier', 'n/a'),
    driftScoreLabel: auditDriftScoreLabel(record),
    tone: compareActionTone(currentAction, archiveAction),
    summary: record.summary || 'MiroFish decision delta recorded.',
  }
}

function auditDriftScoreLabel(record: AuroraIntentAuditRecord): string {
  const score = auditNestedString(record, 'baselineDrift', 'score', '')
  const label = auditNestedString(record, 'baselineDrift', 'label', '')
  if (!score) return ''
  return `Drift ${score}/100${label ? ` ${label}` : ''}`
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCompareTone(value: unknown): value is CompareTone {
  return value === 'aligned' || value === 'watch' || value === 'risk' || value === 'neutral'
}

function auditNestedString(
  record: AuroraIntentAuditRecord,
  section: string,
  key: string,
  fallback: string,
): string {
  const sectionValue = record.payload?.[section]
  if (!isRecordObject(sectionValue)) return fallback
  const value = sectionValue[key]
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function isMiroFishDecisionAuditRecord(record: AuroraIntentAuditRecord): boolean {
  return record.toolId === 'quant.mirofish.run' &&
    record.payload?.source === 'mirofish-current-archive-compare'
}

function clearRevealTimer() {
  if (!revealTimer) return
  window.clearInterval(revealTimer)
  revealTimer = null
}

function startReveal() {
  clearRevealTimer()
  revealStage.value = 1
  revealTimer = window.setInterval(() => {
    revealStage.value += 1
    if (revealStage.value >= 4) clearRevealTimer()
  }, 260)
}

function formatProbability(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const percent = value <= 1 ? value * 100 : value
  return `${Math.round(percent)}%`
}

function formatScenarioProbability(value: unknown): string {
  if (typeof value === 'number') return formatProbability(value)
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (/%$/.test(trimmed)) return trimmed
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return formatProbability(numeric)
    return trimmed
  }
  return 'n/a'
}

function formatMultiplier(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '1.00x'
  return `${value.toFixed(2)}x`
}

function cleanText(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') || /"scenarios"\s*:/.test(trimmed)
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed || !looksLikeJsonPayload(trimmed)) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    return isRecordObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function firstStringValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

function scenarioSourceFromRecord(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null
  const direct = record.scenarios
  if (isRecordObject(direct)) return direct
  if (isRecordObject(record.bullish) || isRecordObject(record.neutral) || isRecordObject(record.bearish)) {
    return record
  }
  return null
}

function normalizeTicker(value: unknown): string {
  const ticker = String(value || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : ''
}

function compactMarkdownText(value: unknown, fallback = 'n/a'): string {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback
  return text.replace(/\s+/g, ' ').trim() || fallback
}

function frontmatterSafe(value: unknown): string {
  return compactMarkdownText(value, 'n/a')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

function markdownCell(value: unknown): string {
  return compactMarkdownText(value).replace(/\|/g, '\\|')
}

function csvCell(value: unknown): string {
  return `"${compactMarkdownText(value).replace(/"/g, '""')}"`
}

function auditSlug(value: unknown): string {
  const slug = compactMarkdownText(value, 'snapshot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug || 'snapshot').slice(0, 54)
}

function auditTimestampSlug(value: string): string {
  const date = new Date(value)
  const source = Number.isNaN(date.getTime()) ? new Date() : date
  return source.toISOString().slice(0, 19).replace(/[-:T]/g, '')
}

function auditEntryKind(entry: QuantLabAuditSnapshotEntry): NonNullable<QuantLabAuditSnapshotEntry['kind']> {
  if (entry.kind === 'compare-markdown' || /^mirofish-compare-.+\.md$/i.test(entry.fileName)) return 'compare-markdown'
  if (entry.kind === 'batch-csv' || /^mirofish-batch-.+\.csv$/i.test(entry.fileName)) return 'batch-csv'
  if (entry.kind === 'batch-markdown' || /^mirofish-batch-.+\.md$/i.test(entry.fileName)) return 'batch-markdown'
  return 'audit-snapshot'
}

function auditEntryCategory(entry: QuantLabAuditSnapshotEntry): AuditGalleryFilter {
  if (auditEntryKind(entry) === 'compare-markdown') return 'compare'
  return auditEntryKind(entry) === 'audit-snapshot' ? 'audit' : 'batch'
}

function auditEntryLabel(entry: QuantLabAuditSnapshotEntry): string {
  return entry.categoryLabel || (auditEntryCategory(entry) === 'batch' ? 'Batch Export' : 'Audit Snapshot')
}

function auditEntryDisplayTitle(entry: QuantLabAuditSnapshotEntry): string {
  if (auditEntryCategory(entry) === 'compare') return entry.title
  return auditEntryCategory(entry) === 'batch' ? entry.title : entry.signal
}

function isAuditSnapshotEntry(entry: QuantLabAuditSnapshotEntry): boolean {
  return auditEntryKind(entry) === 'audit-snapshot'
}

function auditEntryMatchesAction(entry: QuantLabAuditSnapshotEntry, filter: AuditGalleryActionFilter): boolean {
  if (filter === 'all') return true
  const action = filter.toUpperCase()
  const haystack = [
    entry.signal,
    entry.title,
    entry.summary,
    entry.content,
  ].join('\n').toUpperCase()
  return new RegExp(`\\b${action}\\b`).test(haystack)
}

function auditEntryMatchesDrift(entry: QuantLabAuditSnapshotEntry, filter: AuditGalleryDriftFilter): boolean {
  if (filter === 'all') return true
  const raw = compactMarkdownText(entry.driftScore, '')
  if (!/\d/.test(raw)) return false
  const drift = numberFromText(raw)
  if (filter === 'stable') return drift === 0
  if (filter === 'changed') return drift > 0
  return drift >= 10
}

function auditEntryMatchesDate(entry: QuantLabAuditSnapshotEntry, filter: AuditGalleryDateFilter): boolean {
  if (filter === 'all') return true
  const created = new Date(entry.createdAt)
  if (Number.isNaN(created.getTime())) return false
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const createdTime = created.getTime()
  if (filter === 'today') return createdTime >= startOfToday
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  return createdTime >= Date.now() - sevenDaysMs
}

function parseCsvPreviewLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '"' && quoted && next === '"') {
      current += '"'
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === ',' && !quoted) {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells.map(cell => compactMarkdownText(cell))
}

function parseCsvPreviewTable(content: string): CsvPreviewTable | null {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return null
  const headers = parseCsvPreviewLine(lines[0])
  if (!headers.length) return null
  const rows = lines.slice(1).map(parseCsvPreviewLine)
  return {
    headers,
    rows: rows.slice(0, 24),
    totalRows: rows.length,
  }
}

function compareCsvCells(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

function sortCsvPreviewTable(table: CsvPreviewTable): CsvPreviewTable {
  if (!csvPreviewSortHeader.value) return table
  const columnIndex = table.headers.findIndex(header => header === csvPreviewSortHeader.value)
  if (columnIndex < 0) return table
  const direction = csvPreviewSortDirection.value === 'desc' ? -1 : 1
  return {
    ...table,
    rows: [...table.rows].sort((left, right) =>
      compareCsvCells(left[columnIndex] || '', right[columnIndex] || '') * direction,
    ),
  }
}

function toggleCsvPreviewSort(header: string) {
  if (csvPreviewSortHeader.value === header) {
    csvPreviewSortDirection.value = csvPreviewSortDirection.value === 'asc' ? 'desc' : 'asc'
    return
  }
  csvPreviewSortHeader.value = header
  csvPreviewSortDirection.value = 'asc'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function auditSnapshotLine(entry: QuantLabAuditSnapshotEntry, label: string, fallback = 'n/a'): string {
  const pattern = new RegExp(`^-\\s*${escapeRegExp(label)}:\\s*(.+)$`, 'im')
  return compactMarkdownText(entry.content.match(pattern)?.[1], fallback)
}

function auditSnapshotSectionContent(entry: QuantLabAuditSnapshotEntry, heading: string): string {
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i')
  const lines = entry.content.split(/\r?\n/)
  const startIndex = lines.findIndex(line => headingPattern.test(line.trim()))
  if (startIndex < 0) return ''

  const body: string[] = []
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) break
    body.push(lines[index])
  }
  return body.join('\n')
}

function auditSnapshotSectionLine(
  entry: QuantLabAuditSnapshotEntry,
  heading: string,
  label: string,
  fallback = 'n/a',
): string {
  const section = auditSnapshotSectionContent(entry, heading)
  if (!section) return fallback
  const pattern = new RegExp(`^-\\s*${escapeRegExp(label)}:\\s*(.+)$`, 'im')
  return compactMarkdownText(section.match(pattern)?.[1], fallback)
}

function signalAction(signal: string): string {
  const action = compactMarkdownText(signal).split(/\s+/)[0]?.toUpperCase()
  return action || 'n/a'
}

function auditSnapshotMetrics(entry: QuantLabAuditSnapshotEntry) {
  const signal = compactMarkdownText(
    entry.signal ||
      auditSnapshotSectionLine(entry, 'Current Decision', 'Signal', '') ||
      auditSnapshotLine(entry, 'Signal'),
    entry.fileName,
  )
  const risk = auditSnapshotSectionLine(
    entry,
    'Current Decision',
    'Risk multiplier',
    auditSnapshotSectionLine(entry, 'Current Decision', 'Risk', auditSnapshotLine(entry, 'Risk multiplier', auditSnapshotLine(entry, 'Risk', 'n/a'))),
  )
  return {
    signal,
    action: auditSnapshotSectionLine(entry, 'Current Decision', 'Action', auditSnapshotLine(entry, 'Action', signalAction(signal))),
    confidence: compactMarkdownText(
      entry.confidence ||
        auditSnapshotSectionLine(entry, 'Current Decision', 'Confidence', '') ||
        auditSnapshotLine(entry, 'Confidence'),
      'n/a',
    ),
    driftScore: compactMarkdownText(
      entry.driftScore ||
        auditSnapshotSectionLine(entry, 'Pinned Baseline Drift', 'Score', '') ||
        auditSnapshotSectionLine(entry, 'Baseline Drift', 'Drift Score', '') ||
        auditSnapshotLine(entry, 'Drift Score'),
      'n/a',
    ),
    riskMultiplier: risk,
    summary: compactMarkdownText(entry.summary, 'MiroFish audit snapshot.'),
  }
}

function auditSnapshotScenarioKey(value: string): ScenarioKey {
  const normalized = value.toLowerCase()
  if (normalized.includes('bull')) return 'bull-shock'
  if (normalized.includes('bear')) return 'bear-shock'
  if (normalized.includes('macro')) return 'macro-stress'
  return 'base'
}

function auditSnapshotDriftLabel(entry: QuantLabAuditSnapshotEntry, driftScore: string): BaselineDriftScore['label'] {
  const explicit = auditSnapshotSectionLine(
    entry,
    'Pinned Baseline Drift',
    'Label',
    auditSnapshotSectionLine(entry, 'Baseline Drift', 'Severity', ''),
  )
  const normalized = explicit.toLowerCase()
  if (normalized.includes('high')) return 'High'
  if (normalized.includes('medium')) return 'Medium'
  const score = numberFromText(driftScore)
  return score >= 70 ? 'High' : score >= 35 ? 'Medium' : 'Low'
}

function auditSnapshotArchiveAction(entry: QuantLabAuditSnapshotEntry): string {
  const fromArchiveSection = auditSnapshotSectionLine(entry, 'Archive Baseline', 'Action', '')
  if (fromArchiveSection) return fromArchiveSection.toUpperCase()
  const summary = compactMarkdownText(entry.summary, '')
  const match = summary.match(/\bvs\s+([A-Z]+)(?:\s+[A-Z0-9.-]+)?/i)
  return match?.[1]?.toUpperCase() || 'ARCHIVE'
}

function auditSnapshotArchiveConfidence(entry: QuantLabAuditSnapshotEntry): string {
  const fromArchiveSection = auditSnapshotSectionLine(entry, 'Archive Baseline', 'Confidence', '')
  if (fromArchiveSection) return fromArchiveSection
  const summary = compactMarkdownText(entry.summary, '')
  const match = summary.match(/\barchive\s+([A-Za-z]+)/i)
  return match?.[1] || 'n/a'
}

function auditSnapshotContributions(entry: QuantLabAuditSnapshotEntry): BaselineDriftContribution[] {
  const lines = entry.content.split(/\r?\n/)
  const headerIndex = lines.findIndex(line =>
    /^\|\s*Factor\s*\|\s*Points\s*\|\s*Current\s*\|\s*Baseline\s*\|\s*Reason\s*\|/i.test(line.trim()),
  )
  if (headerIndex < 0) return []

  const rows: BaselineDriftContribution[] = []
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('|')) break
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(cell => compactMarkdownText(cell.replace(/\\\|/g, '|'), ''))
    if (cells.length < 5) continue
    const points = numberFromText(cells[1])
    rows.push({
      key: auditSlug(cells[0] || `factor-${index}`),
      label: cells[0] || 'Replay factor',
      points,
      tone: points >= 30 ? 'risk' : points > 0 ? 'watch' : 'aligned',
      reason: cells[4] || 'Replay contribution restored from audit snapshot.',
      current: cells[2] || 'n/a',
      baseline: cells[3] || 'n/a',
    })
  }
  return rows
}

function auditSnapshotReplayRecord(entry: QuantLabAuditSnapshotEntry): AuroraIntentAuditRecord {
  const metrics = auditSnapshotMetrics(entry)
  const scenario = auditSnapshotSectionLine(entry, 'Current Decision', 'Scenario', 'Base')
  const driftScore = numberFromText(metrics.driftScore)
  const driftLabel = auditSnapshotDriftLabel(entry, metrics.driftScore)
  const driftTone: CompareTone = driftScore >= 70 ? 'risk' : driftScore > 0 ? 'watch' : 'aligned'
  const archiveAction = auditSnapshotArchiveAction(entry)
  const archiveTitle = auditSnapshotSectionLine(entry, 'Archive Baseline', 'Title', `Snapshot baseline ${archiveAction}`)
  const archiveFileName = auditSnapshotSectionLine(entry, 'Archive Baseline', 'File name', '')

  return {
    id: `snapshot-${auditSlug(entry.fileName)}-${auditTimestampSlug(entry.createdAt)}`,
    input: `Replay MiroFish audit snapshot: ${metrics.signal}`,
    status: 'completed',
    timestamp: entry.createdAt || new Date().toISOString(),
    toolId: 'quant.mirofish.run',
    toolName: 'MiroFish Snapshot Replay',
    securityLevel: 'L1_ReadOnly',
    appKind: 'mirofish-arena',
    summary: metrics.summary,
    payload: {
      source: 'mirofish-current-archive-compare',
      current: {
        action: metrics.action,
        signal: metrics.signal,
        scenario,
        scenarioKey: auditSnapshotScenarioKey(scenario),
        confidence: metrics.confidence,
        riskMultiplier: metrics.riskMultiplier,
        topSignal: auditSnapshotSectionLine(entry, 'Current Decision', 'Top signal', metrics.signal),
        summary: auditSnapshotSectionLine(entry, 'Current Decision', 'Summary', metrics.summary),
      },
      archive: {
        title: archiveTitle,
        fileName: archiveFileName,
        action: archiveAction,
        confidence: auditSnapshotArchiveConfidence(entry),
        topSignal: auditSnapshotSectionLine(entry, 'Archive Baseline', 'Top signal', 'n/a'),
        relativePath: auditSnapshotSectionLine(entry, 'Archive Baseline', 'Source path', entry.relativePath),
        summary: auditSnapshotSectionLine(entry, 'Archive Baseline', 'Summary', metrics.summary),
      },
      baselineDrift: {
        source: 'mirofish-gallery-snapshot-replay',
        score: driftScore,
        label: driftLabel,
        tone: driftTone,
        detail: auditSnapshotSectionLine(entry, 'Pinned Baseline Drift', 'Detail', metrics.summary),
        pinnedSignal: auditSnapshotSectionLine(entry, 'Pinned Baseline Drift', 'Pinned signal', archiveAction),
        contributions: auditSnapshotContributions(entry),
      },
      deltas: auditSnapshotCompareRows.value.map(row => ({
        label: row.label,
        current: row.current,
        archive: row.baseline,
        tone: row.tone,
      })),
      snapshot: {
        fileName: entry.fileName,
        relativePath: entry.relativePath,
        kind: auditEntryKind(entry),
      },
    },
  }
}

function numberFromText(value: unknown): number {
  const match = compactMarkdownText(value).match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function compareRow(
  label: string,
  current: string,
  baseline: string,
  tone: AuditSnapshotCompareRow['tone'],
  detail: string,
): AuditSnapshotCompareRow {
  return { label, current, baseline, tone, detail }
}

function auditSection(record: AuroraIntentAuditRecord, section: string): Record<string, unknown> {
  const value = record.payload?.[section]
  return isRecordObject(value) ? value : {}
}

function auditField(record: AuroraIntentAuditRecord, section: string, key: string, fallback = 'n/a'): string {
  const value = auditSection(record, section)[key]
  return compactMarkdownText(value, fallback)
}

function auditJsonBlock(record: AuroraIntentAuditRecord): string {
  return JSON.stringify({
    id: record.id,
    input: record.input,
    status: record.status,
    timestamp: record.timestamp,
    toolId: record.toolId,
    toolName: record.toolName,
    securityLevel: record.securityLevel,
    appKind: record.appKind,
    summary: record.summary,
    payload: record.payload,
  }, null, 2).replace(/```/g, '` ` `')
}

function auditSnapshotFileName(record: AuroraIntentAuditRecord): string {
  return `mirofish-audit-${auditTimestampSlug(record.timestamp)}-${auditSlug(auditField(record, 'current', 'signal', record.input))}.md`
}

function buildAuditSnapshotMarkdown(record: AuroraIntentAuditRecord): string {
  const current = auditSection(record, 'current')
  const archive = auditSection(record, 'archive')
  const drift = auditSection(record, 'baselineDrift')
  const deltas = Array.isArray(record.payload?.deltas)
    ? record.payload.deltas.filter(isRecordObject)
    : []
  const contributions = replayDriftContributions.value
  const matrixRows = scenarioMatrixRows.value
  const currentSignal = auditField(record, 'current', 'signal', record.input)
  const summary = compactMarkdownText(record.summary, 'MiroFish decision audit replay.')
  const driftScore = typeof drift.score === 'number' ? drift.score : auditField(record, 'baselineDrift', 'score', 'n/a')
  const driftLabel = auditField(record, 'baselineDrift', 'label', 'n/a')

  const lines = [
    '---',
    `title: "MiroFish Audit Snapshot - ${frontmatterSafe(currentSignal)}"`,
    `date: ${new Date().toISOString()}`,
    'source: Aurora Intent Audit Replay',
    'type: mirofish-audit-snapshot',
    'tags:',
    '  - aurora',
    '  - mirofish',
    '  - quant-lab',
    '  - audit-replay',
    `confidence: "${frontmatterSafe(current.confidence)}"`,
    `drift_score: ${compactMarkdownText(driftScore)}`,
    '---',
    '',
    '# MiroFish Audit Snapshot',
    '',
    `> ${summary}`,
    '',
    '## Current Decision',
    '',
    `- Action: ${compactMarkdownText(current.action)}`,
    `- Signal: ${compactMarkdownText(current.signal)}`,
    `- Scenario: ${compactMarkdownText(current.scenario)}`,
    `- Confidence: ${compactMarkdownText(current.confidence)}`,
    `- Risk multiplier: ${compactMarkdownText(current.riskMultiplier)}`,
    `- Top signal: ${compactMarkdownText(current.topSignal)}`,
    `- Summary: ${compactMarkdownText(current.summary, summary)}`,
    '',
    '## Archive Baseline',
    '',
    `- Title: ${compactMarkdownText(archive.title)}`,
    `- Action: ${compactMarkdownText(archive.action)}`,
    `- Confidence: ${compactMarkdownText(archive.confidence)}`,
    `- Top signal: ${compactMarkdownText(archive.topSignal)}`,
    `- Source path: ${compactMarkdownText(archive.relativePath)}`,
    `- Summary: ${compactMarkdownText(archive.summary)}`,
    '',
    '## Pinned Baseline Drift',
    '',
    `- Score: ${compactMarkdownText(driftScore)}/100`,
    `- Label: ${driftLabel}`,
    `- Tone: ${compactMarkdownText(drift.tone)}`,
    `- Detail: ${compactMarkdownText(drift.detail)}`,
    `- Pinned signal: ${compactMarkdownText(drift.pinnedSignal)}`,
    '',
    '## Drift Contributions',
    '',
  ]

  if (contributions.length) {
    lines.push('| Factor | Points | Current | Baseline | Reason |')
    lines.push('| --- | ---: | --- | --- | --- |')
    for (const item of contributions) {
      lines.push(`| ${markdownCell(item.label)} | ${item.points} | ${markdownCell(item.current)} | ${markdownCell(item.baseline)} | ${markdownCell(item.reason)} |`)
    }
  } else {
    lines.push('No weighted drift contributions were present in this replay.')
  }

  lines.push('', '## Current vs Archive Delta', '')
  if (deltas.length) {
    lines.push('| Field | Current | Archive | Tone |')
    lines.push('| --- | --- | --- | --- |')
    for (const item of deltas) {
      lines.push(`| ${markdownCell(item.label)} | ${markdownCell(item.current)} | ${markdownCell(item.archive)} | ${markdownCell(item.tone)} |`)
    }
  } else {
    lines.push('No explicit current/archive deltas were captured.')
  }

  lines.push('', '## Scenario Matrix', '')
  if (matrixRows.length) {
    lines.push('| Scenario | Action | Risk | Bull | Bear | Confidence | Thesis |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const row of matrixRows) {
      lines.push(`| ${markdownCell(row.label)} | ${markdownCell(row.action)} | ${markdownCell(row.riskMultiplier)} | ${markdownCell(row.bullProbability)} | ${markdownCell(row.bearProbability)} | ${markdownCell(row.confidence)} | ${markdownCell(row.thesis)} |`)
    }
  } else {
    lines.push('Scenario matrix was not available when this snapshot was exported.')
  }

  lines.push(
    '',
    '## Raw Audit Payload',
    '',
    '```json',
    auditJsonBlock(record),
    '```',
    '',
    '> Paper trading research only. This snapshot is not financial advice and does not submit real trades.',
    '',
  )

  return lines.join('\n')
}

function resetAuditExportState() {
  auditExportStatus.value = ''
  auditExportPath.value = ''
  auditExportError.value = ''
}

async function exportAuditSnapshot() {
  const record = replayAuditRecord.value
  resetAuditExportState()
  if (!record) {
    auditExportError.value = 'No replay audit record is available to export.'
    return
  }

  const fileName = auditSnapshotFileName(record)
  auditExporting.value = true
  try {
    const response = await saveQuantLabReport({
      fileName,
      content: buildAuditSnapshotMarkdown(record),
    })
    auditExportStatus.value = 'Snapshot exported'
    auditExportPath.value = response.relativePath || response.path
    selectedAuditSnapshotFile.value = fileName
    void loadAuditSnapshots()
  } catch (err: any) {
    auditExportError.value = err?.message || 'Audit snapshot export failed.'
  } finally {
    auditExporting.value = false
  }
}

function resetAuditCompareExportState() {
  auditCompareExportStatus.value = ''
  auditCompareExportPath.value = ''
  auditCompareExportError.value = ''
}

function auditCompareFileName(current: QuantLabAuditSnapshotEntry, baseline: QuantLabAuditSnapshotEntry): string {
  return `mirofish-compare-${auditTimestampSlug(new Date().toISOString())}-${auditSlug(current.signal)}-vs-${auditSlug(baseline.signal)}.md`
}

function buildAuditCompareMarkdown(current: QuantLabAuditSnapshotEntry, baseline: QuantLabAuditSnapshotEntry): string {
  const rows = auditSnapshotCompareRows.value
  return [
    '---',
    `title: "MiroFish Snapshot Compare - ${frontmatterSafe(current.signal)} vs ${frontmatterSafe(baseline.signal)}"`,
    `date: "${new Date().toISOString()}"`,
    'type: mirofish-audit-compare',
    `current: "${frontmatterSafe(current.fileName)}"`,
    `baseline: "${frontmatterSafe(baseline.fileName)}"`,
    'submit_backend: false',
    '---',
    '',
    '# MiroFish Snapshot Compare',
    '',
    `> ${current.signal} compared with ${baseline.signal}. Paper trading research only; no backend trade submission.`,
    '',
    '## Sources',
    '',
    `- Current: ${markdownCell(current.relativePath)}`,
    `- Baseline: ${markdownCell(baseline.relativePath)}`,
    '',
    '## Compare Rows',
    '',
    '| Metric | Current | Baseline | Tone | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${markdownCell(row.label)} | ${markdownCell(row.current)} | ${markdownCell(row.baseline)} | ${markdownCell(row.tone)} | ${markdownCell(row.detail)} |`),
    '',
    '## Current Preview',
    '',
    '```md',
    selectedAuditSnapshotPreview.value.replace(/```/g, '` ` `'),
    '```',
    '',
  ].join('\n')
}

async function exportAuditSnapshotCompare() {
  resetAuditCompareExportState()
  const current = selectedAuditSnapshot.value
  const baseline = comparisonAuditSnapshot.value
  if (!current || !baseline || !isAuditSnapshotEntry(current) || !isAuditSnapshotEntry(baseline)) {
    auditCompareExportError.value = 'Select two audit snapshots before exporting compare.'
    return
  }

  auditCompareExporting.value = true
  try {
    const response = await saveQuantLabReport({
      fileName: auditCompareFileName(current, baseline),
      content: buildAuditCompareMarkdown(current, baseline),
    })
    auditCompareExportStatus.value = 'Compare exported'
    auditCompareExportPath.value = response.relativePath || response.path
  } catch (err: any) {
    auditCompareExportError.value = err?.message || 'Compare export failed.'
  } finally {
    auditCompareExporting.value = false
  }
}

async function loadAuditSnapshots() {
  auditGalleryLoading.value = true
  auditGalleryError.value = ''
  try {
    const response = await getQuantLabAuditSnapshots(16)
    auditSnapshots.value = response.entries || []
    const availableFiles = new Set(auditSnapshots.value.map(entry => entry.fileName))
    const prunedHidden = hiddenAuditSnapshotFiles.value.filter(fileName => availableFiles.has(fileName))
    if (prunedHidden.length !== hiddenAuditSnapshotFiles.value.length) {
      hiddenAuditSnapshotFiles.value = prunedHidden
      persistHiddenAuditSnapshotFiles(prunedHidden)
    }
    if (!selectedAuditSnapshotFile.value && visibleAuditSnapshots.value[0]) {
      selectedAuditSnapshotFile.value = visibleAuditSnapshots.value[0].fileName
    }
    if (selectedAuditSnapshotFile.value && !visibleAuditSnapshots.value.some(entry => entry.fileName === selectedAuditSnapshotFile.value)) {
      selectedAuditSnapshotFile.value = visibleAuditSnapshots.value[0]?.fileName || ''
    }
    if (compareAuditSnapshotFile.value && !auditSnapshots.value.some(entry => entry.fileName === compareAuditSnapshotFile.value)) {
      compareAuditSnapshotFile.value = ''
    }
    if (pinnedAuditSnapshotFile.value && !auditSnapshots.value.some(entry => entry.fileName === pinnedAuditSnapshotFile.value && isAuditSnapshotEntry(entry))) {
      pinnedAuditSnapshotFile.value = ''
      persistPinnedAuditSnapshotFile('')
    }
    if (!compareAuditSnapshotFile.value || compareAuditSnapshotFile.value === selectedAuditSnapshotFile.value) {
      compareAuditSnapshotFile.value =
        pinnedAuditSnapshot.value?.fileName && pinnedAuditSnapshot.value.fileName !== selectedAuditSnapshotFile.value
          ? pinnedAuditSnapshot.value.fileName
          : visibleAuditSnapshots.value.find(entry => entry.fileName !== selectedAuditSnapshotFile.value && isAuditSnapshotEntry(entry))?.fileName || ''
    }
  } catch (err: any) {
    auditGalleryError.value = err?.message || 'Audit snapshot gallery failed to load.'
  } finally {
    auditGalleryLoading.value = false
  }
}

function toggleAuditSnapshotGallery() {
  auditGalleryOpen.value = !auditGalleryOpen.value
  if (auditGalleryOpen.value && !auditSnapshots.value.length && !auditGalleryLoading.value) {
    void loadAuditSnapshots()
  }
}

function selectAuditSnapshot(fileName: string) {
  selectedAuditSnapshotFile.value = fileName
  if (compareAuditSnapshotFile.value === fileName) {
    compareAuditSnapshotFile.value = visibleAuditSnapshots.value.find(entry => entry.fileName !== fileName)?.fileName || ''
  }
}

function hideAuditGalleryEntry(fileName: string) {
  if (!auditSnapshots.value.some(entry => entry.fileName === fileName)) return
  const nextHidden = Array.from(new Set([...hiddenAuditSnapshotFiles.value, fileName]))
  hiddenAuditSnapshotFiles.value = nextHidden
  persistHiddenAuditSnapshotFiles(nextHidden)

  if (selectedAuditSnapshotFile.value === fileName) {
    selectedAuditSnapshotFile.value = visibleAuditSnapshots.value[0]?.fileName || ''
  }
  if (compareAuditSnapshotFile.value === fileName) {
    compareAuditSnapshotFile.value = visibleAuditSnapshots.value.find(entry =>
      entry.fileName !== selectedAuditSnapshotFile.value && isAuditSnapshotEntry(entry),
    )?.fileName || ''
  }
}

function restoreHiddenAuditGalleryEntries() {
  hiddenAuditSnapshotFiles.value = []
  persistHiddenAuditSnapshotFiles([])
  if (!selectedAuditSnapshotFile.value && auditSnapshots.value[0]) {
    selectedAuditSnapshotFile.value = auditSnapshots.value[0].fileName
  }
}

function selectAuditSnapshotCompare(fileName: string) {
  const entry = auditSnapshots.value.find(item => item.fileName === fileName)
  if (!entry || !isAuditSnapshotEntry(entry) || fileName === selectedAuditSnapshot.value?.fileName) return
  compareAuditSnapshotFile.value = fileName
}

function replayAuditSnapshotFromGallery(fileName: string) {
  const entry = auditSnapshots.value.find(item => item.fileName === fileName)
  if (!entry || !isAuditSnapshotEntry(entry)) return
  const record = auditSnapshotReplayRecord(entry)
  galleryReplayRecord.value = record
  resetAuditExportState()
  applyReplayRecord(record)
}

function handleAuditGalleryKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return
  if (event.key === 'Escape') {
    auditGalleryOpen.value = false
    event.preventDefault()
    return
  }

  const entries = filteredAuditSnapshots.value
  if (!entries.length) return
  const currentIndex = Math.max(0, entries.findIndex(entry => entry.fileName === selectedAuditSnapshotFile.value))
  let nextIndex = currentIndex
  if (event.key === 'ArrowDown') nextIndex = Math.min(entries.length - 1, currentIndex + 1)
  else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = entries.length - 1
  else return

  selectedAuditSnapshotFile.value = entries[nextIndex].fileName
  event.preventDefault()
}

function pinAuditSnapshotBaseline(fileName: string) {
  const entry = auditSnapshots.value.find(item => item.fileName === fileName)
  if (!entry || !isAuditSnapshotEntry(entry)) return
  pinnedAuditSnapshotFile.value = fileName
  if (fileName !== selectedAuditSnapshot.value?.fileName) {
    compareAuditSnapshotFile.value = fileName
  }
  persistPinnedAuditSnapshotFile(fileName)
}

function clearPinnedAuditSnapshotBaseline() {
  pinnedAuditSnapshotFile.value = ''
  persistPinnedAuditSnapshotFile('')
}

function argumentContent(argument: QuantLabMiroFishDebateArgument | undefined, fallback: string): string {
  return cleanText(argument?.content, fallback)
}

function reasoningBullets(content: string): ReasoningBullet[] {
  const normalized = cleanText(content, '')
  if (!normalized) return []

  const chunks = normalized
    .replace(/([。！？!?])\s*/g, '$1|')
    .replace(/\.\s+/g, '.|')
    .replace(/[；;]\s*/g, '|')
    .replace(/\s+\|\s+/g, '|')
    .split('|')
    .map(item => item.trim())
    .filter(Boolean)

  const items = chunks.length > 1 ? chunks : [normalized]
  return items.slice(0, 12).map((item, index) => ({
    key: `${index}-${item.slice(0, 24)}`,
    segments: highlightReasoningSegments(item),
  }))
}

function highlightReasoningSegments(value: string): ReasoningSegment[] {
  const pattern = /\b(?:Risk-(?:Off|On)|[A-Z]{2,6}\s+(?:\d{1,3}(?:\.\d+)?\s+)?(?:BUY|SELL|HOLD|WATCH|REJECT)|(?:BUY|SELL|HOLD|WATCH|REJECT)\s+[A-Z]{2,6}|BUY|SELL|HOLD|WATCH|REJECT|BLOCKED|\d+(?:\.\d+)?(?:%|x))\b/g
  const segments: ReasoningSegment[] = []
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ text: value.slice(cursor, index), highlight: false })
    segments.push({ text: match[0], highlight: true })
    cursor = index + match[0].length
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), highlight: false })
  return segments.length ? segments : [{ text: value, highlight: false }]
}

function formatBatchScore(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}

function makeBatchResult(
  pick: Partial<QuantLabTopPick> & { ticker: string },
  status: QuantRiskBridgeBatchResult['status'],
  summary = 'Queued for sandbox risk bridge.',
): QuantRiskBridgeBatchResult {
  return {
    ticker: pick.ticker,
    action: compactMarkdownText(pick.action, 'WATCH'),
    score: formatBatchScore(pick.score),
    risk: compactMarkdownText(pick.risk, 'n/a'),
    confidence: 'Pending',
    riskMultiplier: 'n/a',
    status,
    summary,
  }
}

function summarizeBatchRun(
  ticker: string,
  fallbackPick: Partial<QuantLabTopPick>,
  response: RunQuantLabMiroFishResult,
): QuantRiskBridgeBatchResult {
  const pick = response.topPicks.find(item => item.ticker === ticker) || response.topPicks[0] || fallbackPick
  const inference = response.mirofish.inference
  return {
    ticker,
    action: compactMarkdownText(pick.action, 'WATCH'),
    score: formatBatchScore(pick.score),
    risk: compactMarkdownText(pick.risk, 'n/a'),
    confidence: archiveConfidenceLabel(inference?.confidence) || 'Medium',
    riskMultiplier: formatMultiplier(inference?.debate?.macro.RiskMultiplier),
    status: 'complete',
    summary: cleanText(
      inference?.debate?.judgeRaw ||
        inference?.support?.[0] ||
        pick.reason,
      'Sandbox completed for this candidate.',
    ),
  }
}

function updateBatchResult(ticker: string, next: Partial<QuantRiskBridgeBatchResult>) {
  batchResults.value = batchResults.value.map(item =>
    item.ticker === ticker ? { ...item, ...next } : item,
  )
}

function resetBatchExportState() {
  batchExportStatus.value = ''
  batchExportPath.value = ''
  batchExportError.value = ''
}

function batchExportFileName(format: BatchExportFormat): string {
  const extension = format === 'csv' ? 'csv' : 'md'
  return `mirofish-batch-${auditTimestampSlug(new Date().toISOString())}-${auditSlug(activeScenarioPreset.value.label)}.${extension}`
}

function buildBatchExportMarkdown(): string {
  const completed = batchResults.value.filter(item => item.status === 'complete').length
  const failed = batchResults.value.filter(item => item.status === 'failed').length
  const rows = batchResults.value

  const lines = [
    '---',
    `title: "MiroFish Batch Risk Bridge - ${frontmatterSafe(activeScenarioPreset.value.label)}"`,
    `date: ${new Date().toISOString()}`,
    'source: Aurora Quant Risk Bridge Batch',
    'type: mirofish-batch-risk-bridge',
    'tags:',
    '  - aurora',
    '  - mirofish',
    '  - quant-lab',
    '  - batch-risk-bridge',
    `scenario: "${frontmatterSafe(activeScenarioPreset.value.label)}"`,
    `batch_count: ${rows.length}`,
    `complete_count: ${completed}`,
    `failed_count: ${failed}`,
    '---',
    '',
    '# MiroFish Batch Risk Bridge',
    '',
    `> ${completed}/${rows.length} candidates completed in ${activeScenarioPreset.value.label}; ${failed} failed. Backend submission remained disabled.`,
    '',
    '## Batch Context',
    '',
    `- Scenario: ${activeScenarioPreset.value.label}`,
    `- Source: ${compactMarkdownText(quantRiskBridgeContext.value?.snapshotSource || result.value?.source || 'Quant Lab')}`,
    `- Snapshot generated at: ${compactMarkdownText(quantRiskBridgeContext.value?.snapshotGeneratedAt || result.value?.generatedAt)}`,
    `- Decision summary: ${compactMarkdownText(bridgeDecisionSummary.value)}`,
    `- Submit backend: false`,
    '',
    '## Candidate Results',
    '',
  ]

  if (rows.length) {
    lines.push('| Ticker | Action | Score | Risk | Confidence | Risk Multiplier | Status | Summary |')
    lines.push('| --- | --- | ---: | --- | --- | --- | --- | --- |')
    for (const item of rows) {
      lines.push(`| ${markdownCell(item.ticker)} | ${markdownCell(item.action)} | ${markdownCell(item.score)} | ${markdownCell(item.risk)} | ${markdownCell(item.confidence)} | ${markdownCell(item.riskMultiplier)} | ${markdownCell(item.status)} | ${markdownCell(item.summary)} |`)
    }
  } else {
    lines.push('No batch results were available when this report was exported.')
  }

  lines.push(
    '',
    '## Raw Batch Results',
    '',
    '```json',
    JSON.stringify(rows, null, 2).replace(/```/g, '` ` `'),
    '```',
    '',
    '> Paper trading research only. This batch report is not financial advice and does not submit real trades.',
    '',
  )

  return lines.join('\n')
}

function buildBatchExportCsv(): string {
  const rows = [
    ['ticker', 'action', 'score', 'risk', 'confidence', 'risk_multiplier', 'status', 'summary'],
    ...batchResults.value.map(item => [
      item.ticker,
      item.action,
      item.score,
      item.risk,
      item.confidence,
      item.riskMultiplier,
      item.status,
      item.summary,
    ]),
  ]
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`
}

async function exportBatchResults(format: BatchExportFormat) {
  resetBatchExportState()
  if (!batchExportReady.value) {
    batchExportError.value = 'Run the batch sandbox before exporting results.'
    return
  }

  batchExporting.value = format
  try {
    const response = await saveQuantLabReport({
      fileName: batchExportFileName(format),
      content: format === 'csv' ? buildBatchExportCsv() : buildBatchExportMarkdown(),
    })
    batchExportStatus.value = format === 'csv' ? 'CSV exported' : 'Markdown exported'
    batchExportPath.value = response.relativePath || response.path
  } catch (err: any) {
    batchExportError.value = err?.message || 'Batch export failed.'
  } finally {
    batchExporting.value = ''
  }
}

async function runBatchRiskBridge() {
  const picks = bridgeBatchPicks.value
  if (!picks.length) {
    batchError.value = 'No Top 10 candidates are available for batch risk bridge.'
    return
  }

  clearRevealTimer()
  loading.value = true
  batchRunning.value = true
  batchError.value = ''
  resetBatchExportState()
  error.value = ''
  result.value = null
  revealStage.value = 1
  batchResults.value = picks.map(pick => makeBatchResult(pick, 'queued'))

  try {
    for (const pick of picks) {
      activeBatchTicker.value = pick.ticker
      updateBatchResult(pick.ticker, { status: 'running', summary: 'MiroFish agents are debating this candidate.' })
      try {
        const response = await runQuantLabMiroFish({
          phase: activeScenarioPreset.value.phase,
          submitBackend: false,
          scenario: activeScenarioPreset.value.key,
          targetTicker: pick.ticker,
        })
        result.value = response
        updateBatchResult(pick.ticker, summarizeBatchRun(pick.ticker, pick, response))
      } catch (err: any) {
        const safeMessage = toMiroFishSafeErrorMessage(err, 'MiroFish sandbox entered safe mode for this candidate.')
        updateBatchResult(pick.ticker, {
          status: 'failed',
          confidence: 'Failed',
          summary: safeMessage,
        })
        batchError.value = safeMessage
      }
    }

    if (result.value) {
      startReveal()
      void loadArchives()
    } else {
      revealStage.value = 4
      error.value = batchError.value || 'MiroFish batch sandbox failed.'
    }
  } finally {
    loading.value = false
    batchRunning.value = false
  }
}

function formatArchiveDate(value: string | undefined): string {
  if (!value) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function archiveConfidenceLabel(value: string | undefined): string {
  if (!value) return 'unknown'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function inferArchiveAction(archive: QuantLabEvidenceArchiveEntry): string {
  const text = [archive.title, archive.summary, archive.support, archive.oppose]
    .filter(Boolean)
    .join(' ')
    .toUpperCase()

  if (text.includes('SELL') || text.includes('REJECT')) return 'SELL'
  if (text.includes('BUY')) return 'BUY'
  if (text.includes('WATCH')) return 'WATCH'
  if (text.includes('HOLD')) return 'HOLD'
  return 'ARCHIVE'
}

function compareActionTone(current: string, archiveAction: string): CompareTone {
  if (current === archiveAction) return 'aligned'
  if (archiveAction === 'WATCH' || archiveAction === 'HOLD') return 'watch'
  if ((current === 'BUY' && archiveAction === 'SELL') || (current === 'SELL' && archiveAction === 'BUY')) return 'risk'
  return 'neutral'
}

function confidenceTone(current: string | undefined, archive: string | undefined): CompareTone {
  if (!current || !archive) return 'neutral'
  if (current === archive) return 'aligned'
  if (current === 'high' && archive === 'low') return 'risk'
  if (current === 'low' && archive === 'high') return 'risk'
  return 'watch'
}

function parseMultiplierLabel(value: string): number | null {
  const numeric = Number.parseFloat(value.replace(/[^\d.-]/g, ''))
  return Number.isFinite(numeric) ? numeric : null
}

function compareRiskTone(current: string, baseline: string): CompareTone {
  const currentValue = parseMultiplierLabel(current)
  const baselineValue = parseMultiplierLabel(baseline)
  if (currentValue === null || baselineValue === null) return 'neutral'
  const delta = currentValue - baselineValue
  if (Math.abs(delta) < 0.03) return 'aligned'
  return delta > 0 ? 'risk' : 'watch'
}

function driftScoreWeight(row: ArchiveCompareRow): number {
  if (row.tone === 'aligned' || row.tone === 'neutral') return 0

  const actionWeight = row.tone === 'risk' ? 45 : 24
  const riskWeight = row.tone === 'risk' ? 30 : 16
  const signalWeight = row.tone === 'risk' ? 22 : 14
  const confidenceWeight = row.tone === 'risk' ? 18 : 10

  if (row.key === 'pinned-action') return actionWeight
  if (row.key === 'pinned-risk') return riskWeight
  if (row.key === 'pinned-top-signal') return signalWeight
  return confidenceWeight
}

function driftContributionReason(row: ArchiveCompareRow, points: number): string {
  if (points === 0 && row.tone === 'aligned') {
    return `${row.label} matches the pinned baseline.`
  }
  if (points === 0) {
    return `${row.label} is informational and does not add drift score.`
  }

  if (row.key === 'pinned-action') {
    return row.tone === 'risk'
      ? 'Opposing BUY/SELL action adds maximum action drift.'
      : 'Action moved away from baseline but is not an opposing flip.'
  }

  if (row.key === 'pinned-risk') {
    return row.tone === 'risk'
      ? 'Current risk multiplier is above the pinned baseline.'
      : 'Risk moved lower than baseline and is tracked as a watch drift.'
  }

  if (row.key === 'pinned-top-signal') {
    return 'Top ranked signal differs from the pinned decision.'
  }

  return row.tone === 'risk'
    ? 'Confidence moved between high and low regimes.'
    : 'Confidence changed from the pinned regime.'
}

function toBaselineDriftContribution(row: ArchiveCompareRow): BaselineDriftContribution {
  const points = driftScoreWeight(row)
  return {
    key: row.key,
    label: row.label,
    points,
    tone: row.tone,
    reason: driftContributionReason(row, points),
    current: row.current,
    baseline: row.archive,
  }
}

function toBaselineDriftAlert(row: ArchiveCompareRow): BaselineDriftAlert {
  if (row.key === 'pinned-action') {
    return {
      key: row.key,
      title: row.tone === 'risk' ? 'Action Flip Alert' : 'Action Drift Watch',
      detail: `Current ${row.current} differs from pinned baseline ${row.archive}.`,
      tone: row.tone,
    }
  }

  if (row.key === 'pinned-risk') {
    return {
      key: row.key,
      title: row.tone === 'risk' ? 'Risk Multiplier Alert' : 'Risk Lower Than Baseline',
      detail: `Current risk ${row.current}; pinned baseline ${row.archive}.`,
      tone: row.tone,
    }
  }

  if (row.key === 'pinned-top-signal') {
    return {
      key: row.key,
      title: 'Top Signal Shift',
      detail: `Current signal ${row.current}; pinned baseline ${row.archive}.`,
      tone: row.tone,
    }
  }

  return {
    key: row.key,
    title: 'Confidence Drift',
    detail: `Current confidence ${row.current}; pinned baseline ${row.archive}.`,
    tone: row.tone,
  }
}

function isPinnedDecision(id: string): boolean {
  return pinnedDecisionId.value === id
}

function togglePinnedDecision(id: string) {
  const nextId = isPinnedDecision(id) ? '' : id
  pinnedDecisionId.value = nextId
  baselineDrilldownOpen.value = false
  persistPinnedDecisionId(nextId)
}

function clearPinnedDecision() {
  pinnedDecisionId.value = ''
  baselineDrilldownOpen.value = false
  persistPinnedDecisionId('')
}

function decisionAuditKey(currentResult: RunQuantLabMiroFishResult, archive: QuantLabEvidenceArchiveEntry): string {
  return [
    activeScenarioPreset.value.key,
    currentResult.generatedAt || inference.value?.updatedAt || 'current',
    archive.fileName,
    currentSignalLabel.value,
    riskMultiplier.value,
  ].join(':')
}

function baselineDriftPayload() {
  const pinnedItem = pinnedDecisionItem.value
  const pinnedRecord = pinnedDecisionRecord.value
  if (!pinnedItem || !pinnedRecord || pinnedBaselineCompareRows.value.length === 0) return null

  return {
    source: 'mirofish-pinned-baseline',
    score: baselineDriftScore.value.score,
    label: baselineDriftScore.value.label,
    tone: baselineDriftScore.value.tone,
    detail: baselineDriftScore.value.detail,
    scenario: {
      key: activeScenarioPreset.value.key,
      label: activeScenarioPreset.value.label,
    },
    pinnedRecordId: pinnedRecord.id,
    pinnedSignal: pinnedItem.currentSignal,
    pinnedArchiveTitle: pinnedItem.archiveTitle,
    contributions: baselineDriftContributions.value.map(item => ({
      key: item.key,
      label: item.label,
      points: item.points,
      tone: item.tone,
      reason: item.reason,
      current: item.current,
      baseline: item.baseline,
    })),
  }
}

function recordDecisionAuditTrail() {
  const archive = selectedArchive.value
  const currentResult = result.value
  if (!archive || !currentResult || archiveCompareRows.value.length === 0) return

  const archiveAction = inferArchiveAction(archive)
  const key = decisionAuditKey(currentResult, archive)
  if (auditedComparisonKeys.has(key)) return
  auditedComparisonKeys.add(key)

  const record = intentAuditStore.record({
    input: `MiroFish decision audit: ${currentSignalLabel.value} vs ${archive.title}`,
    status: 'completed',
    toolId: 'quant.mirofish.run',
    toolName: 'RunMiroFishTool',
    securityLevel: 'L1_ReadOnly',
    appKind: 'mirofish-arena',
    summary: `Decision delta: ${currentSignalLabel.value} vs ${archiveAction}; risk ${riskMultiplier.value}; archive ${archiveConfidenceLabel(archive.confidence)}.`,
    payload: {
      source: 'mirofish-current-archive-compare',
      current: {
        action: finalAction.value,
        signal: currentSignalLabel.value,
        scenario: activeScenarioPreset.value.label,
        scenarioKey: activeScenarioPreset.value.key,
        confidence: currentConfidenceLabel.value,
        riskMultiplier: riskMultiplier.value,
        baseRiskMultiplier: baseRiskMultiplier.value,
        topSignal: topPick.value ? `${topPick.value.ticker} ${topPick.value.score.toFixed(1)}` : 'Pending',
        summary: scenarioSummary.value,
      },
      archive: {
        title: archive.title,
        fileName: archive.fileName,
        action: archiveAction,
        confidence: archiveConfidenceLabel(archive.confidence),
        graphOk: archive.graphOk,
        topSignal: archive.topDegrees?.[0]
          ? `${archive.topDegrees[0].ticker} degree ${archive.topDegrees[0].degree}`
          : 'n/a',
        summary: archive.summary,
        support: archive.support,
        oppose: archive.oppose,
        relativePath: archive.relativePath,
      },
      deltas: archiveCompareRows.value.map(row => ({
        label: row.label,
        current: row.current,
        archive: row.archive,
        tone: row.tone,
      })),
    },
  })
  auditedComparisonRecordIds.set(key, record.id)
}

function enrichDecisionAuditDrift() {
  const archive = selectedArchive.value
  const currentResult = result.value
  const driftPayload = baselineDriftPayload()
  if (!archive || !currentResult || !driftPayload) return

  const key = decisionAuditKey(currentResult, archive)
  const recordId = auditedComparisonRecordIds.get(key) ||
    decisionAuditRecords.value.find(record =>
      record.input === `MiroFish decision audit: ${currentSignalLabel.value} vs ${archive.title}`,
    )?.id
  if (!recordId) return

  const signature = JSON.stringify(driftPayload)
  if (driftAuditSignatures.get(recordId) === signature) return
  driftAuditSignatures.set(recordId, signature)

  intentAuditStore.updateRecord(recordId, record => ({
    ...record,
    payload: {
      ...(record.payload || {}),
      baselineDrift: driftPayload,
    },
  }))
}

function selectArchive(fileName: string) {
  selectedArchiveId.value = fileName
}

function isScenarioKey(value: unknown): value is ScenarioKey {
  return typeof value === 'string' && scenarioPresets.some(preset => preset.key === value)
}

function applyReplayRecord(record = replayAuditRecord.value) {
  if (!record) return

  const scenarioKey = auditNestedString(record, 'current', 'scenarioKey', '')
  if (isScenarioKey(scenarioKey)) {
    activeScenarioKey.value = scenarioKey
    activeScenarioDrilldownKey.value = scenarioKey
  }

  const archiveFileName = auditNestedString(record, 'archive', 'fileName', '')
  if (archiveFileName) {
    selectedArchiveId.value = archiveFileName
  }

  const pinnedRecordId = auditNestedString(record, 'baselineDrift', 'pinnedRecordId', '')
  if (pinnedRecordId) {
    pinnedDecisionId.value = pinnedRecordId
  }

  baselineDrilldownOpen.value = replayDriftContributions.value.length > 0
}

function selectScenarioPreset(key: ScenarioKey) {
  if (loading.value) return
  activeScenarioKey.value = key
  activeScenarioDrilldownKey.value = key
  baselineDrilldownOpen.value = false
  if (isBatchRiskBridge.value) {
    void runBatchRiskBridge()
  } else {
    void runSandbox()
  }
}

function openScenarioDrilldown(key: ScenarioKey) {
  activeScenarioDrilldownKey.value = key
}

function emitFocusPath(path: ArenaFocusPath) {
  emit('focusPath', path)
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function actionForScenario(baseAction: 'BUY' | 'SELL' | 'HOLD', scenarioKey: ScenarioKey): 'BUY' | 'SELL' | 'HOLD' {
  if (scenarioKey === 'bull-shock') {
    return baseAction === 'SELL' ? 'HOLD' : 'BUY'
  }
  if (scenarioKey === 'bear-shock') {
    return baseAction === 'BUY' || baseAction === 'HOLD' ? 'SELL' : baseAction
  }
  if (scenarioKey === 'macro-stress') {
    return baseAction === 'BUY' ? 'HOLD' : baseAction
  }
  return baseAction
}

function probabilityForScenario(kind: 'bullish' | 'bearish', scenarioKey: ScenarioKey): string {
  const base = debate.value?.scenarios[kind].probability ?? 0
  return formatProbability(clampUnit(base + scenarioProbabilityDeltas[scenarioKey][kind]))
}

function confidenceForScenario(scenarioKey: ScenarioKey): string {
  if (scenarioKey === 'base') return currentConfidenceLabel.value
  const baseConfidence = inference.value?.confidence || 'medium'
  if (scenarioKey === 'bull-shock') return baseConfidence === 'low' ? 'Medium' : 'High'
  if (scenarioKey === 'bear-shock') return baseConfidence === 'high' ? 'Medium' : archiveConfidenceLabel(baseConfidence)
  return 'Medium'
}

function formatProbabilityDelta(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0 pts'
  return `${value > 0 ? '+' : ''}${Math.round(value * 100)} pts`
}

function scenarioRiskDetail(preset: ScenarioPreset): string {
  if (preset.key === 'base') {
    return cleanText(debate.value?.macro.MacroInsight, 'Base lens uses the live macro regime without additional stress.')
  }
  if (preset.key === 'bull-shock') {
    return 'Assumes liquidity support and breakout confirmation, lowering the execution risk multiplier.'
  }
  if (preset.key === 'bear-shock') {
    return 'Assumes failed breakout and valuation compression, raising drawdown protection pressure.'
  }
  return 'Assumes policy, liquidity, and volatility stress, reducing conviction before any position sizing.'
}

function scenarioBullDetail(preset: ScenarioPreset): string {
  const base = debate.value?.scenarios.bullish.reasoning || argumentContent(debate.value?.bull, 'Bull case waits for upside confirmation.')
  if (preset.key === 'base') return base
  if (preset.key === 'bull-shock') return `Upside lens amplifies the bull case: ${base}`
  if (preset.key === 'bear-shock') return 'Bear shock discounts upside follow-through until price and breadth repair.'
  return 'Macro stress keeps the bull case alive but demands smaller size and stronger confirmation.'
}

function scenarioBearDetail(preset: ScenarioPreset): string {
  const base = debate.value?.scenarios.bearish.reasoning || argumentContent(debate.value?.bear, 'Bear case challenges valuation, liquidity, and invalidation risk.')
  if (preset.key === 'base') return base
  if (preset.key === 'bull-shock') return 'Bull shock compresses the bear case unless volatility or yields reverse the breakout.'
  if (preset.key === 'bear-shock') return `Drawdown lens elevates the bear case: ${base}`
  return `Macro stress raises the bear case through regime pressure: ${base}`
}

function buildScenarioDrilldown(row: ScenarioMatrixRow, preset: ScenarioPreset): ScenarioMatrixDrilldown {
  const deltas = scenarioProbabilityDeltas[preset.key]
  return {
    row,
    summary: `${row.label} converts the base debate into ${row.action} with ${row.riskMultiplier} risk. ${preset.thesis}`,
    points: [
      {
        key: `${row.key}-macro`,
        tone: 'macro',
        label: 'Macro',
        value: row.riskMultiplier,
        delta: row.riskDeltaLabel,
        detail: scenarioRiskDetail(preset),
      },
      {
        key: `${row.key}-bull`,
        tone: 'bull',
        label: 'Bull',
        value: row.bullProbability,
        delta: formatProbabilityDelta(deltas.bullish),
        detail: scenarioBullDetail(preset),
      },
      {
        key: `${row.key}-bear`,
        tone: 'bear',
        label: 'Bear',
        value: row.bearProbability,
        delta: formatProbabilityDelta(deltas.bearish),
        detail: scenarioBearDetail(preset),
      },
    ],
  }
}

const baseFinalAction = computed(() => {
  const action = topPick.value?.action?.toUpperCase()
  if (action === 'BUY') return 'BUY'
  if (action === 'SELL' || action === 'REJECT') return 'SELL'

  const bullish = debate.value?.scenarios.bullish.probability
  const bearish = debate.value?.scenarios.bearish.probability
  if (typeof bullish === 'number' && typeof bearish === 'number') {
    if (bullish - bearish > 0.15) return 'BUY'
    if (bearish - bullish > 0.15) return 'SELL'
  }
  return 'HOLD'
})

const finalAction = computed(() => {
  return actionForScenario(baseFinalAction.value, activeScenarioPreset.value.key)
})

const parsedJudgeJson = computed(() => parseJsonObjectFromText(debate.value?.judgeRaw || ''))
const verdictRawJsonFallback = computed(() => {
  const raw = debate.value?.judgeRaw || ''
  if (!looksLikeJsonPayload(raw) || parsedJudgeJson.value) return ''
  return raw.trim().slice(0, 900)
})

const finalSummary = computed(() => {
  const parsed = parsedJudgeJson.value
  const parsedSummary = parsed
    ? firstStringValue(parsed, ['summary', 'finalSummary', 'final_summary', 'verdict', 'decision', 'synthesis'])
    : ''
  if (parsedSummary) {
    return cleanText(parsedSummary, 'Hermes Synthesizer parsed the structured scenario output.')
  }
  if (parsed && scenarioSourceFromRecord(parsed)) {
    return 'Hermes Synthesizer returned structured scenario probabilities for the current sandbox verdict.'
  }
  if (verdictRawJsonFallback.value) {
    return 'Hermes Synthesizer returned malformed structured output; inspect the fallback block below.'
  }
  return cleanText(
    debate.value?.judgeRaw ||
      inference.value?.support?.[0] ||
      inference.value?.neutral?.[0] ||
      topPick.value?.reason,
    'Hermes Synthesizer is waiting for the MiroFish sandbox result.',
  )
})

const scenarioSummary = computed(() =>
  activeScenarioPreset.value.key === 'base'
    ? finalSummary.value
    : `${activeScenarioPreset.value.label} scenario lens: ${activeScenarioPreset.value.thesis} ${finalSummary.value}`,
)

const baseRiskMultiplier = computed(() => formatMultiplier(debate.value?.macro.RiskMultiplier))
const riskMultiplier = computed(() => {
  const baseRisk = parseMultiplierLabel(baseRiskMultiplier.value)
  if (baseRisk === null) return baseRiskMultiplier.value
  return formatMultiplier(Math.max(0.1, baseRisk + activeScenarioPreset.value.riskDelta))
})

const verdictScenarioCards = computed<VerdictScenarioCard[]>(() => {
  const source = scenarioSourceFromRecord(parsedJudgeJson.value) || debate.value?.scenarios || null
  if (!source || !isRecordObject(source)) return []

  const cards: VerdictScenarioCard[] = []
  const definitions: Array<{ key: VerdictScenarioCard['key']; label: string }> = [
    { key: 'bullish', label: 'Bullish' },
    { key: 'neutral', label: 'Neutral' },
    { key: 'bearish', label: 'Bearish' },
  ]

  for (const { key, label } of definitions) {
    const scenario = source[key]
    if (!isRecordObject(scenario)) continue
    const reasoning = firstStringValue(scenario, ['reasoning', 'summary', 'thesis', 'detail'])
    cards.push({
      key,
      label,
      probability: formatScenarioProbability(scenario.probability),
      confidence: formatScenarioProbability(scenario.confidence),
      reasoning: truncateText(cleanText(reasoning, `${label} scenario is waiting for structured reasoning.`), 168),
    })
  }

  return cards
})

const scenarioMatrixRows = computed<ScenarioMatrixRow[]>(() => {
  const baseRisk = parseMultiplierLabel(baseRiskMultiplier.value)
  return scenarioPresets.map((preset) => {
    const action = actionForScenario(baseFinalAction.value, preset.key)
    const risk = baseRisk === null
      ? baseRiskMultiplier.value
      : formatMultiplier(Math.max(0.1, baseRisk + preset.riskDelta))
    return {
      key: preset.key,
      label: preset.label,
      badge: preset.badge,
      action,
      actionTone: action.toLowerCase() as ScenarioMatrixRow['actionTone'],
      riskMultiplier: risk,
      riskDeltaLabel: `${preset.riskDelta >= 0 ? '+' : ''}${preset.riskDelta.toFixed(2)}x`,
      bullProbability: probabilityForScenario('bullish', preset.key),
      bearProbability: probabilityForScenario('bearish', preset.key),
      confidence: confidenceForScenario(preset.key),
      thesis: preset.thesis,
    }
  })
})

const activeScenarioDrilldown = computed<ScenarioMatrixDrilldown | null>(() => {
  const row = scenarioMatrixRows.value.find(item => item.key === activeScenarioDrilldownKey.value) || scenarioMatrixRows.value[0]
  const preset = scenarioPresets.find(item => item.key === row?.key) || scenarioPresets[0]
  return row ? buildScenarioDrilldown(row, preset) : null
})

const agentCards = computed<ArenaAgentCard[]>(() => {
  const macro = debate.value?.macro
  const scenarios = debate.value?.scenarios
  const support = inference.value?.support || []
  const oppose = inference.value?.oppose || []
  const neutral = inference.value?.neutral || []
  const macroContent = cleanText(macro?.MacroInsight || neutral[0], 'Macro agent is reading regime, VIX, liquidity, and cross-market pressure.')
  const bullContent = argumentContent(debate.value?.bull, support[0] || topPick.value?.reason || 'Bull agent is looking for upside asymmetry and confirmation.')
  const bearContent = argumentContent(debate.value?.bear, oppose[0] || 'Bear agent is challenging the thesis with drawdown, liquidity, and invalidation risk.')

  return [
    {
      key: 'macro',
      icon: '🌍',
      name: 'Macro',
      stance: macro?.Regime || 'Neutral regime',
      score: riskMultiplier.value,
      confidence: formatProbability(scenarios?.neutral.confidence),
      content: macroContent,
      reasoningBullets: reasoningBullets(macroContent),
      points: [
        `Scenario ${activeScenarioPreset.value.label}`,
        `Evidence ${result.value?.evidenceCount ?? 0}`,
        `Mode ${debate.value?.mode || 'sandbox'}`,
        `Updated ${inference.value?.updatedAt ? new Date(inference.value.updatedAt).toLocaleTimeString() : 'pending'}`,
      ],
    },
    {
      key: 'bull',
      icon: '🐂',
      name: 'Bull',
      stance: debate.value?.bull.title || 'Optimistic case',
      score: formatProbability(scenarios?.bullish.probability),
      confidence: formatProbability(scenarios?.bullish.confidence),
      content: bullContent,
      reasoningBullets: reasoningBullets(bullContent),
      points: [
        topPick.value ? `Top pick ${topPick.value.ticker}` : 'Top pick pending',
        topPick.value ? `Score ${topPick.value.score.toFixed(1)}` : 'Score pending',
        topPick.value ? `Trend ${topPick.value.trend}` : 'Trend pending',
      ],
    },
    {
      key: 'bear',
      icon: '🐻',
      name: 'Bear',
      stance: debate.value?.bear.title || 'Risk case',
      score: formatProbability(scenarios?.bearish.probability),
      confidence: formatProbability(scenarios?.bearish.confidence),
      content: bearContent,
      reasoningBullets: reasoningBullets(bearContent),
      points: [
        `Key risks ${debate.value?.key_risks?.length || oppose.length || 0}`,
        topPick.value ? `Risk ${topPick.value.risk}` : 'Risk pending',
        topPick.value ? `Invalidation ${topPick.value.action}` : 'Action pending',
      ],
    },
  ]
})

async function runSandbox() {
  clearRevealTimer()
  loading.value = true
  error.value = ''
  result.value = null
  revealStage.value = 1
  try {
    result.value = await runQuantLabMiroFish({
      phase: activeScenarioPreset.value.phase,
      submitBackend: false,
      scenario: activeScenarioPreset.value.key,
      targetTicker: bridgeTargetTicker.value || undefined,
      topic: bridgeTopic.value || undefined,
    })
    startReveal()
    void loadArchives()
  } catch (err: any) {
    error.value = toMiroFishSafeErrorMessage(err, 'MiroFish sandbox entered safe mode.')
    revealStage.value = 4
  } finally {
    loading.value = false
  }
}

async function loadArchives() {
  archiveLoading.value = true
  archiveError.value = ''
  try {
    const response = await getQuantLabEvidenceArchives(12)
    archives.value = response.entries || []
    if (!selectedArchiveId.value && archives.value[0]) {
      selectedArchiveId.value = archives.value[0].fileName
    }
  } catch (err: any) {
    archiveError.value = err?.message || 'MiroFish evidence archive failed to load.'
  } finally {
    archiveLoading.value = false
  }
}

onMounted(() => {
  applyReplayRecord()
  if (isBatchRiskBridge.value) {
    void runBatchRiskBridge()
  } else {
    void runSandbox()
  }
  void loadArchives()
})

watch(
  () => replayAuditRecord.value?.id,
  () => {
    resetAuditExportState()
    applyReplayRecord()
  },
)

watch(
  () => props.replayRecord?.id,
  (nextId, previousId) => {
    if (nextId && nextId !== previousId) {
      galleryReplayRecord.value = null
    }
  },
)

watch(
  () => [
    result.value?.generatedAt,
    inference.value?.updatedAt,
    selectedArchive.value?.fileName,
    archiveCompareRows.value.map(row => `${row.key}:${row.current}:${row.archive}`).join('|'),
    pinnedDecisionId.value,
    baselineDriftScore.value.score,
    baselineDriftContributions.value.map(item => `${item.key}:${item.points}:${item.current}:${item.baseline}`).join('|'),
  ],
  () => {
    recordDecisionAuditTrail()
    enrichDecisionAuditDrift()
  },
  { flush: 'post' },
)

watch(auditGalleryOpen, async (open) => {
  if (!open) return
  await nextTick()
  auditGalleryRegion.value?.focus({ preventScroll: true })
})

watch(
  filteredAuditSnapshots,
  (entries) => {
    if (!entries.length) return
    if (!entries.some(entry => entry.fileName === selectedAuditSnapshotFile.value)) {
      selectedAuditSnapshotFile.value = entries[0].fileName
    }
  },
  { flush: 'post' },
)

watch(
  () => selectedAuditSnapshot.value?.fileName,
  () => {
    const selected = selectedAuditSnapshot.value
    if (!selected || auditEntryKind(selected) !== 'batch-csv') {
      csvPreviewSortHeader.value = ''
      csvPreviewSortDirection.value = 'asc'
    }
  },
)

watch(
  () => [
    auditGalleryQuery.value,
    auditGalleryFilter.value,
    auditGalleryActionFilter.value,
    auditGalleryDriftFilter.value,
    auditGalleryDateFilter.value,
    selectedAuditSnapshotFile.value,
  ],
  () => persistAuditGalleryState(),
)

onUnmounted(() => {
  clearRevealTimer()
})
</script>

<template>
  <section class="mirofish-arena" aria-label="MiroFish Debate Arena">
    <header class="arena-hero">
      <div>
        <p>MiroFish Multi-Agent Sandbox</p>
        <h1>Debate Arena</h1>
        <span>Macro, Bull, and Bear agents debate {{ debateSubject }} before Hermes Synthesizer issues a final sandbox verdict.</span>
      </div>
      <div class="arena-hero-actions">
        <button type="button" :disabled="auditGalleryLoading" aria-label="Open MiroFish Audit Snapshot Gallery" @click="toggleAuditSnapshotGallery">
          {{ auditGalleryOpen ? 'Hide Gallery' : 'Audit Gallery' }}
        </button>
        <button type="button" :disabled="loading" @click="runSandbox">
          {{ loading ? 'Simulating' : `Run ${activeScenarioPreset.label}` }}
        </button>
      </div>
    </header>

    <section class="arena-status" :class="{ loading, error: Boolean(error) }">
      <span class="pulse-dot"></span>
      <strong>{{ error ? 'Simulation paused' : loading ? 'Agents are thinking' : 'Sandbox complete' }}</strong>
      <p>{{ error || `Paper trading only. Backend submit is off. Scenario lens: ${activeScenarioPreset.label}.` }}</p>
    </section>

    <div class="agent-grid">
      <article
        v-for="(agent, index) in agentCards"
        :key="agent.key"
        class="agent-card"
        :class="[agent.key, { visible: revealStage > index }]"
        :style="{ transitionDelay: `${index * 90}ms` }"
        role="button"
        tabindex="0"
        :aria-label="`Focus ${agent.name} agent path`"
        @click="emitFocusPath(agent.key)"
        @focusin="emitFocusPath(agent.key)"
        @keydown.enter.prevent="emitFocusPath(agent.key)"
        @keydown.space.prevent="emitFocusPath(agent.key)"
      >
        <div class="agent-header">
          <span class="agent-avatar" aria-hidden="true">{{ agent.icon }}</span>
          <div>
            <p>{{ agent.icon }} {{ agent.name }} Agent</p>
            <h2>{{ agent.stance }}</h2>
          </div>
        </div>

        <div class="agent-stats">
          <article>
            <span>Score</span>
            <strong>{{ agent.score }}</strong>
          </article>
          <article>
            <span>Confidence</span>
            <strong>{{ agent.confidence }}</strong>
          </article>
        </div>

        <div class="agent-content">
          <ul class="agent-reasoning-list" :class="agent.key">
            <li v-for="bullet in agent.reasoningBullets" :key="bullet.key">
              <span
                v-for="(segment, segmentIndex) in bullet.segments"
                :key="`${bullet.key}-${segmentIndex}`"
                :class="segment.highlight ? ['reasoning-highlight', agent.key] : ''"
              >{{ segment.text }}</span>
            </li>
          </ul>
        </div>

        <div class="agent-points">
          <span v-for="point in agent.points" :key="point">{{ point }}</span>
        </div>
      </article>
    </div>

    <section
      v-if="activeScenarioDrilldown"
      class="scenario-drilldown core-agent-delta"
      aria-label="MiroFish Scenario Drilldown"
    >
      <div class="scenario-drilldown-heading">
        <div>
          <p>Agent Delta</p>
          <h3>{{ activeScenarioDrilldown.row.label }} Agent Delta</h3>
          <span>{{ activeScenarioDrilldown.summary }}</span>
        </div>
        <strong :class="activeScenarioDrilldown.row.actionTone">{{ activeScenarioDrilldown.row.action }}</strong>
      </div>
      <div class="scenario-drilldown-grid">
        <article
          v-for="point in activeScenarioDrilldown.points"
          :key="point.key"
          class="scenario-drilldown-point"
          :class="point.tone"
        >
          <div>
            <span>{{ point.label }}</span>
            <strong>{{ point.value }}</strong>
          </div>
          <b>{{ point.delta }}</b>
          <p>{{ point.detail }}</p>
        </article>
      </div>
    </section>

    <section
      class="verdict-panel"
      :class="[finalAction.toLowerCase(), { visible: revealStage >= 4 }]"
      aria-label="Hermes Synthesizer Final Verdict"
      role="button"
      tabindex="0"
      @click="emitFocusPath('verdict')"
      @focusin="emitFocusPath('verdict')"
      @keydown.enter.prevent="emitFocusPath('verdict')"
      @keydown.space.prevent="emitFocusPath('verdict')"
    >
      <div class="verdict-copy">
        <p>Hermes Synthesizer</p>
        <h2>Final Verdict</h2>
        <span>{{ scenarioSummary }}</span>
        <div v-if="verdictScenarioCards.length" class="verdict-scenario-grid" aria-label="Synthesizer Scenario Breakdown">
          <article
            v-for="scenario in verdictScenarioCards"
            :key="scenario.key"
            class="verdict-scenario-card"
            :class="scenario.key"
          >
            <div>
              <span>{{ scenario.label }}</span>
              <strong>{{ scenario.probability }}</strong>
            </div>
            <p>{{ scenario.reasoning }}</p>
            <small>Confidence {{ scenario.confidence }}</small>
          </article>
        </div>
        <pre v-else-if="verdictRawJsonFallback" class="verdict-json-fallback">{{ verdictRawJsonFallback }}</pre>
      </div>
      <div class="verdict-metrics">
        <article class="verdict-action-card" :class="finalAction.toLowerCase()">
          <span>Action</span>
          <strong :class="finalAction.toLowerCase()">{{ finalAction }}</strong>
        </article>
        <article>
          <span>Risk Multiplier</span>
          <strong>{{ riskMultiplier }}</strong>
        </article>
        <article>
          <span>Primary Signal</span>
          <strong>{{ topPick ? `${topPick.ticker} ${topPick.score.toFixed(1)}` : 'Pending' }}</strong>
        </article>
      </div>
    </section>

    <section
      v-if="auditGalleryOpen"
      ref="auditGalleryRegion"
      class="audit-gallery"
      aria-label="MiroFish Audit Snapshot Gallery"
      tabindex="0"
      @keydown="handleAuditGalleryKeydown"
    >
      <div class="audit-gallery-heading">
        <div>
          <p>Audit Snapshot Gallery</p>
          <h2>Markdown Replay Vault</h2>
          <span>Browse exported MiroFish audit snapshots and batch reports from the controlled trading-journal folder.</span>
        </div>
        <div class="audit-gallery-heading-actions">
          <button
            v-if="auditGalleryCounts.hidden"
            type="button"
            aria-label="Restore hidden MiroFish gallery entries"
            @click="restoreHiddenAuditGalleryEntries"
          >
            Restore {{ auditGalleryCounts.hidden }}
          </button>
          <button
            type="button"
            aria-label="Open MiroFish gallery state sync"
            @click="openAuditGalleryStateSync"
          >
            Sync State
          </button>
          <button type="button" :disabled="auditGalleryLoading" @click="loadAuditSnapshots">
            {{ auditGalleryLoading ? 'Loading' : 'Refresh' }}
          </button>
        </div>
      </div>
      <section v-if="auditGallerySyncOpen" class="audit-gallery-sync" aria-label="MiroFish Gallery State Sync">
        <div>
          <p>Portable State</p>
          <h3>Copy or paste Gallery state</h3>
          <span>Manual sync for search, filters, hidden entries, selected preview, and pinned snapshot. No backend write.</span>
        </div>
        <textarea
          v-model="auditGallerySyncText"
          aria-label="MiroFish gallery state JSON"
          spellcheck="false"
        ></textarea>
        <div class="audit-gallery-sync-actions">
          <button type="button" aria-label="Refresh MiroFish gallery state JSON" @click="auditGallerySyncText = JSON.stringify(buildAuditGalleryPortableState(), null, 2)">
            Refresh JSON
          </button>
          <button type="button" aria-label="Apply MiroFish gallery state" @click="applyAuditGalleryStateSync">
            Apply State
          </button>
        </div>
        <p
          v-if="auditGallerySyncStatus || auditGallerySyncError"
          class="audit-gallery-sync-status"
          :class="{ error: Boolean(auditGallerySyncError) }"
        >
          {{ auditGallerySyncError || auditGallerySyncStatus }}
        </p>
      </section>
      <div class="audit-gallery-controls">
        <input
          v-model="auditGalleryQuery"
          type="search"
          placeholder="Search snapshots, batch exports, and compare reports"
          aria-label="Search MiroFish gallery entries"
        />
        <div class="audit-gallery-filters" aria-label="MiroFish Gallery Categories">
          <button
            type="button"
            :class="{ active: auditGalleryFilter === 'all' }"
            aria-label="Show all gallery entries"
            @click="auditGalleryFilter = 'all'"
          >
            All {{ auditGalleryCounts.all }}
          </button>
          <button
            type="button"
            :class="{ active: auditGalleryFilter === 'audit' }"
            aria-label="Show audit snapshot gallery entries"
            @click="auditGalleryFilter = 'audit'"
          >
            Audit {{ auditGalleryCounts.audit }}
          </button>
          <button
            type="button"
            :class="{ active: auditGalleryFilter === 'batch' }"
            aria-label="Show batch export gallery entries"
            @click="auditGalleryFilter = 'batch'"
          >
            Batch {{ auditGalleryCounts.batch }}
          </button>
          <button
            type="button"
            :class="{ active: auditGalleryFilter === 'compare' }"
            aria-label="Show compare report gallery entries"
            @click="auditGalleryFilter = 'compare'"
          >
            Compare {{ auditGalleryCounts.compare }}
          </button>
        </div>
        <div class="audit-gallery-advanced-filters" aria-label="MiroFish Gallery Advanced Filters">
          <select v-model="auditGalleryActionFilter" aria-label="Filter MiroFish gallery by action">
            <option value="all">Any Action</option>
            <option value="buy">BUY</option>
            <option value="hold">HOLD</option>
            <option value="sell">SELL</option>
            <option value="watch">WATCH</option>
          </select>
          <select v-model="auditGalleryDriftFilter" aria-label="Filter MiroFish gallery by drift">
            <option value="all">Any Drift</option>
            <option value="stable">Stable</option>
            <option value="changed">Changed</option>
            <option value="high">High Drift</option>
          </select>
          <select v-model="auditGalleryDateFilter" aria-label="Filter MiroFish gallery by date">
            <option value="all">Any Date</option>
            <option value="today">Today</option>
            <option value="week">Last 7 Days</option>
          </select>
        </div>
      </div>
      <div v-if="auditGalleryError" class="audit-gallery-error">{{ auditGalleryError }}</div>
      <div v-else-if="!auditSnapshots.length" class="audit-gallery-empty">
        {{ auditGalleryLoading ? 'Loading exported snapshots...' : 'No exported MiroFish audit snapshots yet.' }}
      </div>
      <div v-else-if="!visibleAuditSnapshots.length" class="audit-gallery-empty">
        All gallery entries are hidden locally. Restore hidden entries to review them again.
      </div>
      <div v-else-if="!filteredAuditSnapshots.length" class="audit-gallery-empty">
        No gallery entries match the current search or category.
      </div>
      <div v-else class="audit-gallery-layout">
        <div class="audit-gallery-list">
          <article
            v-for="entry in filteredAuditSnapshots"
            :key="entry.fileName"
            class="audit-gallery-entry"
            :class="{
              active: entry.fileName === selectedAuditSnapshot?.fileName,
              comparing: entry.fileName === comparisonAuditSnapshot?.fileName,
              pinned: entry.fileName === pinnedAuditSnapshot?.fileName,
              batch: auditEntryCategory(entry) === 'batch',
              compare: auditEntryCategory(entry) === 'compare',
            }"
          >
            <button
              type="button"
              :aria-label="`Open audit snapshot ${entry.title}`"
              @click="selectAuditSnapshot(entry.fileName)"
            >
              <strong>{{ auditEntryDisplayTitle(entry) }}</strong>
              <span>{{ entry.summary }}</span>
              <small>{{ auditEntryLabel(entry) }} · {{ formatArchiveDate(entry.createdAt) }} · Drift {{ entry.driftScore }}</small>
            </button>
            <button
              v-if="isAuditSnapshotEntry(entry)"
              type="button"
              class="audit-gallery-compare-button"
              :disabled="entry.fileName === selectedAuditSnapshot?.fileName"
              :aria-label="`Compare audit snapshot ${entry.title}`"
              @click="selectAuditSnapshotCompare(entry.fileName)"
            >
              {{ entry.fileName === comparisonAuditSnapshot?.fileName ? 'Comparing' : 'Compare' }}
            </button>
            <button
              v-if="isAuditSnapshotEntry(entry)"
              type="button"
              class="audit-gallery-pin-button"
              :aria-label="`Pin audit snapshot baseline ${entry.title}`"
              @click="pinAuditSnapshotBaseline(entry.fileName)"
            >
              {{ entry.fileName === pinnedAuditSnapshot?.fileName ? 'Pinned' : 'Pin Baseline' }}
            </button>
            <button
              type="button"
              class="audit-gallery-hide-button"
              :aria-label="`Hide gallery entry ${entry.title}`"
              @click="hideAuditGalleryEntry(entry.fileName)"
            >
              Hide
            </button>
          </article>
        </div>
        <article v-if="selectedAuditSnapshot" class="audit-gallery-preview">
          <div class="audit-gallery-preview-head">
            <div>
              <p>{{ auditEntryLabel(selectedAuditSnapshot) }} · {{ selectedAuditSnapshot.confidence }} confidence</p>
              <h3>{{ selectedAuditSnapshot.title }}</h3>
              <span>{{ selectedAuditSnapshot.relativePath }}</span>
            </div>
            <div class="audit-gallery-preview-actions">
              <strong>Drift {{ selectedAuditSnapshot.driftScore }}</strong>
              <button
                v-if="isAuditSnapshotEntry(selectedAuditSnapshot)"
                type="button"
                aria-label="Replay MiroFish audit snapshot from gallery"
                @click="replayAuditSnapshotFromGallery(selectedAuditSnapshot.fileName)"
              >
                Replay Snapshot
              </button>
            </div>
          </div>
          <div
            v-if="selectedBatchCsvPreview"
            class="audit-gallery-csv-preview"
            aria-label="MiroFish Batch CSV Preview Table"
          >
            <div class="audit-gallery-csv-summary">
              <span>{{ selectedBatchCsvPreview.totalRows }} rows</span>
              <strong>{{ selectedAuditSnapshot.fileName }}</strong>
            </div>
            <div class="audit-gallery-csv-scroll">
              <table>
                <thead>
                  <tr>
                    <th v-for="header in selectedBatchCsvPreview.headers" :key="header">
                      <button
                        type="button"
                        :aria-label="`Sort MiroFish CSV preview by ${header}`"
                        :class="{ active: csvPreviewSortHeader === header }"
                        @click="toggleCsvPreviewSort(header)"
                      >
                        {{ header }}
                        <span v-if="csvPreviewSortHeader === header">{{ csvPreviewSortDirection === 'asc' ? '↑' : '↓' }}</span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in selectedBatchCsvPreview.rows" :key="`${selectedAuditSnapshot.fileName}-${rowIndex}`">
                    <td v-for="(header, cellIndex) in selectedBatchCsvPreview.headers" :key="`${header}-${cellIndex}`">
                      {{ row[cellIndex] || 'n/a' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <pre v-else>{{ selectedAuditSnapshotPreview }}</pre>
          <section v-if="isAuditSnapshotEntry(selectedAuditSnapshot) && pinnedAuditSnapshot" class="audit-gallery-pinned" aria-label="MiroFish Pinned Audit Snapshot Baseline">
            <div>
              <p>Pinned Snapshot Baseline</p>
              <h3>{{ pinnedAuditSnapshot.signal }}</h3>
              <span>{{ pinnedAuditSnapshot.relativePath }}</span>
            </div>
            <button type="button" aria-label="Clear pinned audit snapshot baseline" @click="clearPinnedAuditSnapshotBaseline">
              Clear
            </button>
          </section>
          <section v-if="isAuditSnapshotEntry(selectedAuditSnapshot) && comparisonAuditSnapshot" class="audit-gallery-compare" aria-label="MiroFish Audit Snapshot Compare">
            <div class="audit-gallery-compare-head">
              <div>
                <p>{{ comparisonAuditSnapshot.fileName === pinnedAuditSnapshot?.fileName ? 'Pinned Baseline Compare' : 'Snapshot Compare' }}</p>
                <h3>{{ selectedAuditSnapshot.signal }} vs {{ comparisonAuditSnapshot.signal }}</h3>
                <span>{{ selectedAuditSnapshot.fileName }} compared with {{ comparisonAuditSnapshot.fileName }}</span>
              </div>
              <button
                type="button"
                :disabled="auditCompareExporting"
                aria-label="Export MiroFish audit snapshot compare"
                @click="exportAuditSnapshotCompare"
              >
                {{ auditCompareExporting ? 'Exporting' : 'Export Compare' }}
              </button>
            </div>
            <div
              v-if="auditCompareExportStatus || auditCompareExportError"
              class="audit-gallery-compare-export-status"
              :class="{ error: Boolean(auditCompareExportError) }"
            >
              <strong>{{ auditCompareExportError || auditCompareExportStatus }}</strong>
              <span v-if="auditCompareExportPath">{{ auditCompareExportPath }}</span>
            </div>
            <div class="audit-gallery-compare-grid">
              <article
                v-for="row in auditSnapshotCompareRows"
                :key="row.label"
                class="audit-gallery-compare-row"
                :class="row.tone"
              >
                <span>{{ row.label }}</span>
                <strong>{{ row.current }} -> {{ row.baseline }}</strong>
                <p>{{ row.detail }}</p>
              </article>
            </div>
          </section>
        </article>
      </div>
    </section>

    <section v-if="isAuditReplay" class="audit-replay-card" aria-label="MiroFish Audit Replay">
      <div class="audit-replay-heading">
        <div>
          <p>Audit Replay</p>
          <h2>{{ replayScenarioLabel }}</h2>
          <span>{{ replayAuditRecord?.summary || 'Replaying a saved MiroFish decision audit inside the Arena.' }}</span>
        </div>
        <div class="audit-replay-actions">
          <strong>{{ replayDriftLabel }}</strong>
          <button
            type="button"
            :disabled="auditExporting"
            aria-label="Export MiroFish audit snapshot"
            @click="exportAuditSnapshot"
          >
            {{ auditExporting ? 'Exporting' : 'Export Snapshot' }}
          </button>
        </div>
      </div>
      <div class="audit-replay-tags">
        <span>Archive {{ replayArchiveLabel }}</span>
        <span>Baseline {{ replayBaselineLabel }}</span>
        <span>{{ replayAuditRecord?.timestamp ? formatArchiveDate(replayAuditRecord.timestamp) : 'Replay' }}</span>
      </div>
      <div v-if="replaySourceTags.length" class="audit-replay-source-tags">
        <span v-for="tag in replaySourceTags" :key="tag">{{ tag }}</span>
      </div>
      <div v-if="replayDeltaBadges.length" class="audit-replay-delta-badges" aria-label="MiroFish Replay Delta Badges">
        <span
          v-for="badge in replayDeltaBadges"
          :key="badge.key"
          :class="badge.tone"
        >
          {{ badge.label }} {{ badge.current }} -> {{ badge.archive }}
        </span>
      </div>
      <div
        v-if="auditExportStatus || auditExportError"
        class="audit-export-status"
        :class="{ error: Boolean(auditExportError) }"
        aria-live="polite"
      >
        <span>{{ auditExportError || auditExportStatus }}</span>
        <strong v-if="auditExportPath">{{ auditExportPath }}</strong>
      </div>
      <div v-if="replayDriftContributions.length" class="audit-replay-contributions">
        <article
          v-for="item in replayDriftContributions"
          :key="item.key"
          class="baseline-score-contribution"
          :class="item.tone"
        >
          <div>
            <strong>{{ item.label }}</strong>
            <span>{{ item.reason }}</span>
          </div>
          <div>
            <b>+{{ item.points }}</b>
            <small>pts</small>
          </div>
          <p>Current {{ item.current }} · Baseline {{ item.baseline }}</p>
        </article>
      </div>
    </section>

    <section v-if="quantRiskBridgeContext" class="quant-bridge-card" aria-label="Quant Risk Bridge">
      <div class="quant-bridge-heading">
        <div>
          <p>Quant Risk Bridge</p>
          <h2>{{ isBatchRiskBridge ? 'Batch Risk Bridge' : bridgeTargetTicker || bridgePick?.ticker || 'Focused ticker' }}</h2>
          <span>{{ bridgeDecisionSummary }}</span>
        </div>
        <strong>{{ bridgePick?.action || topPick?.action || 'WATCH' }}</strong>
      </div>
      <div class="quant-bridge-metrics">
        <span>Score {{ bridgePick?.score ?? topPick?.score ?? 'n/a' }}</span>
        <span>Risk {{ bridgePick?.risk || topPick?.risk || 'n/a' }}</span>
        <span>{{ quantRiskBridgeContext.snapshotSource || result?.source || 'Quant Lab' }}</span>
        <span>{{ quantRiskBridgeContext.snapshotGeneratedAt || 'Live sandbox' }}</span>
      </div>
      <div v-if="quantRiskBridgeContext.marketPulse?.length" class="quant-bridge-pulse">
        <span
          v-for="item in quantRiskBridgeContext.marketPulse"
          :key="`${item.label}-${item.value}`"
          :class="`tone-${item.tone || 'neutral'}`"
        >
          {{ item.label }} <b>{{ item.value }}</b>
        </span>
      </div>
    </section>

    <section v-if="isBatchRiskBridge" class="quant-bridge-batch-card" aria-label="Quant Risk Bridge Batch">
      <div class="quant-bridge-batch-heading">
        <div>
          <p>Batch Sandbox</p>
          <h2>{{ bridgeBatchPicks.length }} candidates queued</h2>
          <span>Runs Top candidates through MiroFish one by one with submitBackend disabled.</span>
        </div>
        <div class="quant-bridge-batch-actions">
          <button
            type="button"
            :disabled="batchRunning || loading"
            aria-label="Run MiroFish batch risk bridge again"
            @click="runBatchRiskBridge"
          >
            {{ batchRunning ? 'Running Batch' : 'Run Batch Again' }}
          </button>
          <button
            type="button"
            :disabled="!batchExportReady || Boolean(batchExporting)"
            aria-label="Export MiroFish batch Markdown"
            @click="exportBatchResults('markdown')"
          >
            {{ batchExporting === 'markdown' ? 'Exporting MD' : 'Export MD' }}
          </button>
          <button
            type="button"
            :disabled="!batchExportReady || Boolean(batchExporting)"
            aria-label="Export MiroFish batch CSV"
            @click="exportBatchResults('csv')"
          >
            {{ batchExporting === 'csv' ? 'Exporting CSV' : 'Export CSV' }}
          </button>
        </div>
      </div>
      <div v-if="batchError" class="quant-bridge-batch-error">{{ batchError }}</div>
      <div
        v-if="batchExportStatus || batchExportError"
        class="quant-bridge-batch-export-status"
        :class="{ error: Boolean(batchExportError) }"
      >
        <span>{{ batchExportError || batchExportStatus }}</span>
        <strong v-if="batchExportPath">{{ batchExportPath }}</strong>
      </div>
      <div class="quant-bridge-batch-grid">
        <article
          v-for="item in batchResults"
          :key="item.ticker"
          class="quant-bridge-batch-row"
          :class="[item.status, { active: item.ticker === bridgeTargetTicker }]"
        >
          <div>
            <span>{{ item.status }}</span>
            <h3>{{ item.ticker }}</h3>
          </div>
          <strong>{{ item.action }}</strong>
          <small>Score {{ item.score }} · Risk {{ item.risk }} · {{ item.riskMultiplier }}</small>
          <p>{{ item.summary }}</p>
        </article>
      </div>
    </section>

    <section class="advanced-settings-drawer" :class="{ open: advancedSettingsOpen }" aria-label="MiroFish Advanced Settings">
      <button
        class="advanced-settings-summary"
        type="button"
        :aria-expanded="advancedSettingsOpen"
        aria-controls="mirofish-advanced-settings-content"
        @click="advancedSettingsOpen = !advancedSettingsOpen"
      >
        <div>
          <p>Advanced Settings</p>
          <h2>Scenario Controls</h2>
          <span>Presets, decision matrix, and agent deltas stay available without stealing the Arena spotlight.</span>
        </div>
        <strong>{{ activeScenarioPreset.label }}</strong>
      </button>

      <div
        v-show="advancedSettingsOpen"
        id="mirofish-advanced-settings-content"
        class="advanced-settings-content"
      >
        <section class="scenario-presets" aria-label="MiroFish Scenario Presets">
          <div class="scenario-presets-header">
            <div>
              <p>Scenario Presets</p>
              <h2>{{ activeScenarioPreset.label }}</h2>
              <span>{{ activeScenarioPreset.description }}</span>
            </div>
            <strong>{{ activeScenarioPreset.badge }}</strong>
          </div>
          <div class="scenario-preset-grid">
            <button
              v-for="preset in scenarioPresets"
              :key="preset.key"
              type="button"
              :disabled="loading"
              :class="{ active: preset.key === activeScenarioPreset.key }"
              :aria-label="`Run MiroFish scenario ${preset.label}`"
              @click="selectScenarioPreset(preset.key)"
            >
              <strong>{{ preset.label }}</strong>
              <span>{{ preset.description }}</span>
              <em>{{ preset.badge }}</em>
            </button>
          </div>
        </section>

        <section class="scenario-matrix" aria-label="MiroFish Scenario Comparison Matrix">
          <div class="scenario-matrix-header">
            <div>
              <p>Scenario Matrix</p>
              <h2>四情境決策矩陣</h2>
              <span>Compare all sandbox lenses without submitting backend trades or leaving Aurora App Mode.</span>
            </div>
            <strong>{{ topPick ? topPick.ticker : bridgeTargetTicker || 'Market' }}</strong>
          </div>
          <div class="scenario-matrix-grid">
            <button
              v-for="row in scenarioMatrixRows"
              :key="row.key"
              type="button"
              class="scenario-matrix-row"
              :class="[row.actionTone, { active: row.key === activeScenarioPreset.key, expanded: row.key === activeScenarioDrilldownKey }]"
              :aria-expanded="row.key === activeScenarioDrilldownKey"
              :aria-label="`Inspect MiroFish scenario ${row.label}`"
              @click="openScenarioDrilldown(row.key)"
            >
              <div class="scenario-matrix-title">
                <div>
                  <span>{{ row.badge }}</span>
                  <h3>{{ row.label }}</h3>
                </div>
                <strong :class="row.actionTone">{{ row.action }}</strong>
              </div>
              <div class="scenario-matrix-metrics">
                <div>
                  <span>Risk</span>
                  <strong>{{ row.riskMultiplier }}</strong>
                  <small>{{ row.riskDeltaLabel }}</small>
                </div>
                <div>
                  <span>Bull</span>
                  <strong>{{ row.bullProbability }}</strong>
                  <small>upside</small>
                </div>
                <div>
                  <span>Bear</span>
                  <strong>{{ row.bearProbability }}</strong>
                  <small>drawdown</small>
                </div>
                <div>
                  <span>Conf</span>
                  <strong>{{ row.confidence }}</strong>
                  <small>lens</small>
                </div>
              </div>
              <p>{{ row.thesis }}</p>
            </button>
          </div>
        </section>
      </div>
    </section>

    <section class="decision-timeline-panel" aria-label="MiroFish Decision Timeline">
      <div class="decision-timeline-header">
        <div>
          <p>Decision Audit</p>
          <h2>決策演進時間線</h2>
        </div>
        <span>{{ decisionTimelineItems.length }} records</span>
      </div>

      <p v-if="decisionTimelineItems.length === 0" class="decision-timeline-empty">
        No MiroFish decision deltas have been recorded yet.
      </p>
      <div v-else class="decision-timeline-list">
        <article
          v-for="item in decisionTimelineItems"
          :key="item.id"
          class="decision-timeline-item"
          :class="[item.tone, { pinned: isPinnedDecision(item.id) }]"
        >
          <span class="decision-timeline-node" aria-hidden="true"></span>
          <div>
            <small>{{ formatArchiveDate(item.timestamp) }}</small>
            <h3>{{ item.currentSignal }}</h3>
            <p>{{ item.summary }}</p>
            <div class="decision-timeline-tags">
              <span>Archive {{ item.archiveAction }}</span>
              <span>Risk {{ item.riskMultiplier }}</span>
              <span v-if="item.driftScoreLabel">{{ item.driftScoreLabel }}</span>
              <span>{{ item.archiveTitle }}</span>
            </div>
            <button
              type="button"
              class="decision-pin-button"
              :class="{ active: isPinnedDecision(item.id) }"
              :aria-label="isPinnedDecision(item.id) ? `Unpin decision ${item.currentSignal}` : `Pin decision ${item.currentSignal}`"
              @click="togglePinnedDecision(item.id)"
            >
              {{ isPinnedDecision(item.id) ? 'Pinned Baseline' : 'Pin Baseline' }}
            </button>
          </div>
        </article>
      </div>

      <section class="pinned-baseline" aria-label="MiroFish Pinned Decision Baseline">
        <div class="pinned-baseline-header">
          <div>
            <p>Pinned Baseline</p>
            <h3>{{ pinnedDecisionItem?.currentSignal || 'No decision pinned' }}</h3>
            <span>{{ pinnedDecisionItem?.summary || 'Pin a timeline decision to compare future simulations against a fixed baseline.' }}</span>
          </div>
          <button
            v-if="pinnedDecisionItem"
            type="button"
            aria-label="Clear MiroFish pinned baseline"
            @click="clearPinnedDecision"
          >
            Clear
          </button>
        </div>
        <div v-if="pinnedDecisionItem" class="pinned-baseline-tags">
          <span>Baseline {{ pinnedDecisionItem.currentAction }}</span>
          <span>Archive {{ pinnedDecisionItem.archiveAction }}</span>
          <span>Risk {{ pinnedDecisionItem.riskMultiplier }}</span>
          <span>{{ pinnedDecisionItem.archiveTitle }}</span>
        </div>
        <div v-if="pinnedDecisionItem && pinnedBaselineCompareRows.length" class="pinned-baseline-grid">
          <article
            v-for="row in pinnedBaselineCompareRows"
            :key="row.key"
            class="compare-row"
            :class="row.tone"
          >
            <p>{{ row.label }}</p>
            <div>
              <span>Current</span>
              <strong>{{ row.current }}</strong>
            </div>
            <div>
              <span>Baseline</span>
              <strong>{{ row.archive }}</strong>
            </div>
          </article>
        </div>
        <section v-if="pinnedDecisionItem" class="baseline-alerts" aria-label="MiroFish Baseline Drift Alerts">
          <div class="baseline-alerts-header">
            <p>Baseline Drift Alerts</p>
            <h4>{{ baselineDriftAlerts.length > 0 ? `${baselineDriftAlerts.length} drift signals` : 'Baseline aligned' }}</h4>
          </div>
          <button
            type="button"
            class="baseline-score"
            :class="baselineDriftScore.tone"
            aria-label="MiroFish Baseline Drift Score"
            :aria-expanded="baselineDrilldownOpen"
            @click="baselineDrilldownOpen = !baselineDrilldownOpen"
          >
            <strong>{{ baselineDriftScore.score }} / 100</strong>
            <span>{{ baselineDriftScore.label }} drift</span>
            <small>{{ baselineDriftScore.detail }}</small>
            <em>{{ baselineDrilldownOpen ? 'Hide breakdown' : 'Show breakdown' }}</em>
          </button>
          <Transition name="dropdown-fade">
            <div
              v-if="baselineDrilldownOpen"
              class="baseline-score-drilldown"
              aria-label="MiroFish Baseline Drift Score Breakdown"
            >
              <article
                v-for="item in baselineDriftContributions"
                :key="item.key"
                class="baseline-score-contribution"
                :class="item.tone"
              >
                <div>
                  <strong>{{ item.label }}</strong>
                  <span>{{ item.reason }}</span>
                </div>
                <div>
                  <b>+{{ item.points }}</b>
                  <small>pts</small>
                </div>
                <p>Current {{ item.current }} · Baseline {{ item.baseline }}</p>
              </article>
            </div>
          </Transition>
          <article v-if="baselineDriftAlerts.length === 0" class="baseline-alert stable">
            <strong>No material drift from pinned decision.</strong>
            <span>Action, risk, confidence, and top signal remain aligned with the pinned baseline.</span>
          </article>
          <article
            v-for="alert in baselineDriftAlerts"
            v-else
            :key="alert.key"
            class="baseline-alert"
            :class="alert.tone"
          >
            <strong>{{ alert.title }}</strong>
            <span>{{ alert.detail }}</span>
          </article>
        </section>
      </section>
    </section>

    <section class="archive-panel" aria-label="MiroFish Evidence Timeline">
      <div class="archive-header">
        <div>
          <p>Evidence Archive</p>
          <h2>推演歷史時間軸</h2>
        </div>
        <button type="button" :disabled="archiveLoading" @click="loadArchives">
          {{ archiveLoading ? 'Loading' : 'Refresh Archives' }}
        </button>
      </div>

      <div v-if="archiveError" class="archive-empty">{{ archiveError }}</div>
      <div v-else-if="!archives.length" class="archive-empty">
        No previous MiroFish evidence archive is available yet.
      </div>
      <div v-else class="archive-grid">
        <div class="archive-timeline" role="list">
          <button
            v-for="entry in archives"
            :key="entry.fileName"
            type="button"
            class="archive-entry"
            :class="{ active: selectedArchive?.fileName === entry.fileName }"
            :aria-label="`Open MiroFish archive ${entry.title}`"
            @click="selectArchive(entry.fileName)"
          >
            <span>{{ formatArchiveDate(entry.createdAt || entry.updatedAt) }}</span>
            <strong>{{ entry.title }}</strong>
            <small>{{ archiveConfidenceLabel(entry.confidence) }} · {{ entry.status || 'archived' }}</small>
          </button>
        </div>

        <article v-if="selectedArchive" class="archive-detail">
          <div>
            <p>{{ selectedArchive.phase || 'archive' }} · {{ selectedArchive.source || selectedArchive.graphSource || 'MiroFish' }}</p>
            <h3>{{ selectedArchive.title }}</h3>
            <span>{{ selectedArchive.summary }}</span>
          </div>
          <div class="archive-detail-metrics">
            <article>
              <span>Evidence</span>
              <strong>{{ selectedArchive.evidenceCount ?? 0 }}</strong>
            </article>
            <article>
              <span>Graph</span>
              <strong>{{ selectedArchive.graphOk ? 'Ready' : 'Local' }}</strong>
            </article>
            <article>
              <span>Top Degree</span>
              <strong>{{ selectedArchive.topDegrees[0] ? `${selectedArchive.topDegrees[0].ticker} ${selectedArchive.topDegrees[0].degree}` : 'n/a' }}</strong>
            </article>
          </div>
          <div class="archive-snippets">
            <p v-if="selectedArchive.support"><b>Support</b>{{ selectedArchive.support }}</p>
            <p v-if="selectedArchive.oppose"><b>Oppose</b>{{ selectedArchive.oppose }}</p>
            <small>{{ selectedArchive.relativePath }}</small>
          </div>

          <section class="archive-replay" aria-label="MiroFish Archive Replay">
            <article
              v-for="card in archiveReplayCards"
              :key="card.key"
              class="archive-replay-card"
              :class="card.key"
            >
              <span class="replay-icon" aria-hidden="true">{{ card.icon }}</span>
              <div>
                <p>{{ card.label }}</p>
                <h4>{{ card.title }}</h4>
                <span>{{ card.content }}</span>
                <small>{{ card.meta }}</small>
              </div>
            </article>
          </section>

          <section class="archive-compare" aria-label="MiroFish Current Archive Compare">
            <div class="compare-heading">
              <p>Current vs Archive</p>
              <h4>本次推演對照</h4>
              <span>Compare the live sandbox verdict with the selected evidence archive before changing risk posture.</span>
            </div>
            <div class="compare-grid">
              <article
                v-for="row in archiveCompareRows"
                :key="row.key"
                class="compare-row"
                :class="row.tone"
              >
                <p>{{ row.label }}</p>
                <div>
                  <span>Current</span>
                  <strong>{{ row.current }}</strong>
                </div>
                <div>
                  <span>Archive</span>
                  <strong>{{ row.archive }}</strong>
                </div>
              </article>
            </div>
          </section>
        </article>
      </div>
    </section>

  </section>
</template>

<style scoped lang="scss">
.mirofish-arena {
  position: relative;
  display: grid;
  align-content: start;
  gap: 18px;
  box-sizing: border-box;
  height: 100%;
  min-height: 100%;
  padding: 24px 24px clamp(72px, 8vh, 112px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding-bottom: 112px;
  font-family: Poppins, "Noto Sans TC", "Noto Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: rgba(15, 23, 42, 0.92);
  background:
    radial-gradient(860px 480px at 10% 2%, rgba(99, 102, 241, 0.28), transparent 64%),
    radial-gradient(760px 460px at 88% 12%, rgba(244, 63, 94, 0.18), transparent 66%),
    radial-gradient(700px 400px at 48% 92%, rgba(16, 185, 129, 0.18), transparent 70%),
    linear-gradient(135deg, rgba(237, 246, 255, 0.82), rgba(246, 240, 255, 0.68) 48%, rgba(232, 252, 247, 0.7));
}

.mirofish-arena::before {
  position: absolute;
  inset: auto -10% 4% -10%;
  height: 220px;
  pointer-events: none;
  content: '';
  background:
    linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.48) 38%, transparent 70%),
    radial-gradient(closest-side at 40% 50%, rgba(121, 99, 255, 0.16), transparent 72%);
  filter: blur(8px);
  opacity: 0.8;
  transform: rotate(-4deg);
}

.arena-hero,
.arena-status,
.audit-gallery,
.audit-replay-card,
.quant-bridge-card,
.quant-bridge-batch-card,
.advanced-settings-drawer,
.scenario-presets,
.scenario-matrix,
.decision-timeline-panel,
.archive-panel,
.agent-card,
.verdict-panel {
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.decision-timeline-panel {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 24px;
}

.decision-timeline-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.decision-timeline-header p,
.decision-timeline-header h2,
.decision-timeline-header span,
.decision-timeline-empty,
.decision-timeline-item small,
.decision-timeline-item h3,
.decision-timeline-item p {
  margin: 0;
}

.decision-timeline-header p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.decision-timeline-header h2 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
}

.decision-timeline-header > span {
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.48);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
}

.decision-timeline-empty {
  padding: 14px;
  border: 1px dashed rgba(121, 99, 255, 0.18);
  border-radius: 18px;
  color: rgba(21, 32, 51, 0.5);
  background: rgba(255, 255, 255, 0.34);
  font-size: 12px;
  font-weight: 800;
}

.decision-timeline-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}

.decision-timeline-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.3)),
    rgba(255, 255, 255, 0.42);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
}

.decision-timeline-item.aligned {
  border-color: rgba(70, 190, 124, 0.26);
}

.decision-timeline-item.watch {
  border-color: rgba(121, 99, 255, 0.26);
}

.decision-timeline-item.risk {
  border-color: rgba(255, 95, 87, 0.26);
}

.decision-timeline-item.pinned {
  border-color: rgba(121, 99, 255, 0.42);
  box-shadow:
    0 14px 32px rgba(121, 99, 255, 0.13),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
}

.decision-timeline-node {
  width: 11px;
  height: 11px;
  margin-top: 5px;
  border-radius: 999px;
  background: #7b61ff;
  box-shadow: 0 0 0 5px rgba(121, 99, 255, 0.12);
}

.decision-timeline-item.aligned .decision-timeline-node {
  background: #46be7c;
  box-shadow: 0 0 0 5px rgba(70, 190, 124, 0.12);
}

.decision-timeline-item.risk .decision-timeline-node {
  background: #ff5f57;
  box-shadow: 0 0 0 5px rgba(255, 95, 87, 0.12);
}

.decision-timeline-item small {
  display: block;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 900;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decision-timeline-item h3 {
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.88);
  font-size: 14px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decision-timeline-item p {
  display: -webkit-box;
  margin-top: 7px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.58);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.decision-timeline-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-top: 9px;
}

.decision-timeline-tags span {
  max-width: 100%;
  padding: 6px 8px;
  overflow: hidden;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.52);
  background: rgba(255, 255, 255, 0.42);
  font-size: 9px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decision-pin-button {
  width: fit-content;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.46);
  cursor: pointer;
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.decision-pin-button:hover,
.decision-pin-button:focus-visible,
.decision-pin-button.active {
  border-color: rgba(121, 99, 255, 0.34);
  background: rgba(255, 255, 255, 0.72);
  outline: none;
  transform: translateY(-1px);
}

.decision-pin-button.active {
  color: #fff;
  background: linear-gradient(135deg, #7b61ff, #50a7ff);
  box-shadow: 0 12px 24px rgba(121, 99, 255, 0.18);
}

.pinned-baseline {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(121, 99, 255, 0.16);
  border-radius: 20px;
  background:
    radial-gradient(360px 180px at 0% 0%, rgba(121, 99, 255, 0.14), transparent 68%),
    rgba(255, 255, 255, 0.36);
}

.pinned-baseline-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.pinned-baseline-header p,
.pinned-baseline-header h3,
.pinned-baseline-header span {
  margin: 0;
}

.pinned-baseline-header p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.pinned-baseline-header h3 {
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.88);
  font-size: 16px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pinned-baseline-header span {
  display: -webkit-box;
  margin-top: 7px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.54);
  font-size: 12px;
  font-weight: 720;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.pinned-baseline-header button {
  padding: 7px 10px;
  border: 1px solid rgba(255, 95, 87, 0.2);
  border-radius: 999px;
  color: #c83232;
  background: rgba(255, 255, 255, 0.46);
  cursor: pointer;
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.pinned-baseline-header button:hover,
.pinned-baseline-header button:focus-visible {
  border-color: rgba(255, 95, 87, 0.34);
  background: rgba(255, 255, 255, 0.72);
  outline: none;
  transform: translateY(-1px);
}

.pinned-baseline-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.pinned-baseline-tags span {
  max-width: 100%;
  padding: 6px 8px;
  overflow: hidden;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.52);
  background: rgba(255, 255, 255, 0.42);
  font-size: 9px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pinned-baseline-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
  min-width: 0;
}

.baseline-alerts {
  display: grid;
  gap: 9px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.34);
}

.baseline-alerts-header p,
.baseline-alerts-header h4,
.baseline-alert strong,
.baseline-alert span {
  margin: 0;
}

.baseline-alerts-header p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.baseline-alerts-header h4 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 14px;
  font-weight: 950;
  line-height: 1.15;
}

.baseline-score {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 4px 10px;
  align-items: center;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(70, 190, 124, 0.24);
  border-radius: 16px;
  appearance: none;
  background: linear-gradient(135deg, rgba(240, 255, 248, 0.66), rgba(255, 255, 255, 0.42));
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.baseline-score:hover,
.baseline-score:focus-visible {
  border-color: rgba(121, 99, 255, 0.28);
  box-shadow: 0 12px 28px rgba(121, 99, 255, 0.12);
  outline: none;
  transform: translateY(-1px);
}

.baseline-score.watch {
  border-color: rgba(255, 176, 32, 0.3);
  background: linear-gradient(135deg, rgba(255, 247, 222, 0.7), rgba(255, 255, 255, 0.4));
}

.baseline-score.risk {
  border-color: rgba(255, 95, 87, 0.34);
  background: linear-gradient(135deg, rgba(255, 232, 232, 0.72), rgba(255, 255, 255, 0.38));
}

.baseline-score strong,
.baseline-score span,
.baseline-score small,
.baseline-score em,
.baseline-score-contribution strong,
.baseline-score-contribution span,
.baseline-score-contribution b,
.baseline-score-contribution small,
.baseline-score-contribution p {
  margin: 0;
}

.baseline-score strong {
  color: #11935a;
  font-size: 18px;
  font-weight: 950;
  line-height: 1;
  white-space: nowrap;
}

.baseline-score.watch strong {
  color: #b26a00;
}

.baseline-score.risk strong {
  color: #c83232;
}

.baseline-score span {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.78);
  font-size: 12px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.baseline-score small {
  grid-column: 1 / 3;
  color: rgba(21, 32, 51, 0.55);
  font-size: 10px;
  font-weight: 720;
  line-height: 1.35;
}

.baseline-score em {
  grid-column: 3;
  grid-row: 1 / 3;
  align-self: center;
  color: rgba(97, 80, 220, 0.68);
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  line-height: 1.15;
  text-align: right;
  text-transform: uppercase;
  white-space: nowrap;
}

.baseline-score-drilldown {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.baseline-score-contribution {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 10px;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.36);
}

.baseline-score-contribution.aligned {
  border-color: rgba(70, 190, 124, 0.2);
}

.baseline-score-contribution.watch {
  border-color: rgba(255, 176, 32, 0.26);
}

.baseline-score-contribution.risk {
  border-color: rgba(255, 95, 87, 0.3);
}

.baseline-score-contribution > div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.baseline-score-contribution > div:nth-child(2) {
  display: grid;
  justify-items: end;
  align-content: start;
  gap: 2px;
}

.baseline-score-contribution strong {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.82);
  font-size: 11px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.baseline-score-contribution span,
.baseline-score-contribution p {
  color: rgba(21, 32, 51, 0.54);
  font-size: 10px;
  font-weight: 720;
  line-height: 1.35;
}

.baseline-score-contribution b {
  color: rgba(21, 32, 51, 0.78);
  font-size: 14px;
  font-weight: 950;
  line-height: 1;
}

.baseline-score-contribution.watch b {
  color: #b26a00;
}

.baseline-score-contribution.risk b {
  color: #c83232;
}

.baseline-score-contribution small {
  color: rgba(97, 80, 220, 0.62);
  font-size: 9px;
  font-weight: 900;
  line-height: 1;
  text-transform: uppercase;
}

.baseline-score-contribution p {
  grid-column: 1 / -1;
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.baseline-alert {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.44);
}

.baseline-alert.risk {
  border-color: rgba(255, 95, 87, 0.3);
}

.baseline-alert.watch {
  border-color: rgba(121, 99, 255, 0.28);
}

.baseline-alert.stable {
  border-color: rgba(70, 190, 124, 0.24);
}

.baseline-alert strong {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.84);
  font-size: 12px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.baseline-alert.risk strong {
  color: #c83232;
}

.baseline-alert.stable strong {
  color: #11935a;
}

.baseline-alert span {
  color: rgba(21, 32, 51, 0.56);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.4;
}

.archive-panel {
  z-index: 1;
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: 24px;
}

.archive-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
}

.archive-header p,
.archive-header h2,
.archive-detail p,
.archive-detail h3,
.archive-detail span,
.archive-snippets p,
.archive-snippets small {
  margin: 0;
}

.archive-header p,
.archive-detail p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.archive-header h2 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
}

.archive-header button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.54);
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.archive-header button:hover,
.archive-header button:focus-visible {
  border-color: rgba(121, 99, 255, 0.32);
  background: rgba(255, 255, 255, 0.74);
  outline: none;
  transform: translateY(-1px);
}

.archive-header button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}

.archive-empty {
  padding: 16px;
  border: 1px dashed rgba(121, 99, 255, 0.18);
  border-radius: 18px;
  color: rgba(21, 32, 51, 0.52);
  background: rgba(255, 255, 255, 0.34);
  font-size: 12px;
  font-weight: 800;
}

.archive-grid {
  display: grid;
  grid-template-columns: minmax(220px, 0.38fr) minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}

.archive-timeline {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  max-height: 240px;
  overflow: auto;
  padding-right: 4px;
}

.archive-entry {
  display: grid;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 16px;
  color: inherit;
  background: rgba(255, 255, 255, 0.42);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.archive-entry:hover,
.archive-entry:focus-visible,
.archive-entry.active {
  border-color: rgba(121, 99, 255, 0.34);
  background: rgba(255, 255, 255, 0.72);
  outline: none;
  transform: translateY(-1px);
}

.archive-entry span,
.archive-entry small {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-entry strong {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.84);
  font-size: 13px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-detail {
  display: grid;
  gap: 13px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.4);
}

.archive-detail h3 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.15;
}

.archive-detail > div:first-child > span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.58);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
}

.archive-detail-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.archive-detail-metrics article {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(121, 99, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.42);
}

.archive-detail-metrics span {
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.archive-detail-metrics strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 14px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-snippets {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.archive-snippets p {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 8px;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}

.archive-snippets b {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.archive-snippets small {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.42);
  font-size: 10px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-replay {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}

.archive-replay-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.3)),
    rgba(255, 255, 255, 0.42);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
}

.archive-replay-card.macro {
  border-color: rgba(80, 167, 255, 0.2);
}

.archive-replay-card.bull {
  border-color: rgba(70, 190, 124, 0.22);
}

.archive-replay-card.bear {
  border-color: rgba(255, 95, 87, 0.2);
}

.archive-replay-card.synth {
  border-color: rgba(121, 99, 255, 0.22);
}

.replay-icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.62);
  box-shadow: 0 10px 22px rgba(52, 67, 104, 0.1);
  color: #6150dc;
  font-size: 17px;
  font-weight: 950;
}

.archive-replay-card p,
.archive-replay-card h4,
.archive-replay-card span,
.archive-replay-card small {
  margin: 0;
}

.archive-replay-card p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.archive-replay-card h4 {
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.88);
  font-size: 13px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-replay-card span {
  display: -webkit-box;
  margin-top: 7px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.58);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.archive-replay-card small {
  display: block;
  margin-top: 8px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-compare {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 20px;
  background:
    radial-gradient(360px 180px at 0% 0%, rgba(121, 99, 255, 0.12), transparent 68%),
    rgba(255, 255, 255, 0.36);
}

.compare-heading p,
.compare-heading h4,
.compare-heading span,
.compare-row p,
.compare-row span,
.compare-row strong {
  margin: 0;
}

.compare-heading p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.compare-heading h4 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 16px;
  font-weight: 950;
  line-height: 1.1;
}

.compare-heading span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.52);
  font-size: 12px;
  font-weight: 720;
  line-height: 1.4;
}

.compare-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
  min-width: 0;
}

.compare-row {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.56);
}

.compare-row.aligned {
  border-color: rgba(70, 190, 124, 0.26);
}

.compare-row.watch {
  border-color: rgba(121, 99, 255, 0.24);
}

.compare-row.risk {
  border-color: rgba(255, 95, 87, 0.26);
}

.compare-row p {
  color: rgba(21, 32, 51, 0.78);
  font-size: 12px;
  font-weight: 950;
  line-height: 1.1;
}

.compare-row div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.compare-row span {
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.compare-row strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 13px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compare-row.aligned strong {
  color: #11935a;
}

.compare-row.risk strong {
  color: #c83232;
}

.arena-hero {
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 20px;
  border-radius: 24px;
}

.arena-hero p,
.arena-hero h1,
.arena-hero span,
.arena-status p,
.audit-replay-heading p,
.audit-replay-heading h2,
.audit-replay-heading span,
.audit-replay-heading strong,
.audit-replay-tags span,
.scenario-presets-header p,
.scenario-presets-header h2,
.scenario-presets-header span,
.scenario-presets-header strong,
.scenario-preset-grid strong,
.scenario-preset-grid span,
.scenario-preset-grid em,
.verdict-copy p,
.verdict-copy h2,
.verdict-copy span,
.agent-header p,
.agent-header h2,
.agent-content {
  margin: 0;
}

.arena-hero p,
.audit-replay-heading p,
.scenario-presets-header p,
.verdict-copy p,
.agent-header p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 11px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.arena-hero h1 {
  margin-top: 8px;
  color: rgba(19, 29, 48, 0.92);
  font-size: 38px;
  font-weight: 950;
  line-height: 1;
}

.arena-hero span,
.verdict-copy span {
  display: block;
  max-width: 820px;
  margin-top: 10px;
  color: rgba(21, 32, 51, 0.58);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.5;
}

.arena-hero-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.arena-hero button {
  min-height: 42px;
  padding: 0 18px;
  border: 1px solid rgba(121, 99, 255, 0.2);
  border-radius: 999px;
  color: #fff;
  background: linear-gradient(135deg, #7b61ff, #50a7ff);
  box-shadow: 0 14px 34px rgba(121, 99, 255, 0.22);
  cursor: pointer;
  font-size: 13px;
  font-weight: 900;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.arena-hero button:hover,
.arena-hero button:focus-visible {
  outline: none;
  transform: translateY(-1px);
}

.arena-hero button:disabled {
  cursor: wait;
  opacity: 0.68;
  transform: none;
}

.arena-status {
  z-index: 1;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 18px;
}

.pulse-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #54d58b;
  box-shadow: 0 0 0 5px rgba(84, 213, 139, 0.14);
}

.arena-status.loading .pulse-dot {
  background: #7b61ff;
  box-shadow: 0 0 0 5px rgba(121, 99, 255, 0.14);
  animation: pulse 1.1s ease-in-out infinite;
}

.arena-status.error .pulse-dot {
  background: #ff5f57;
  box-shadow: 0 0 0 5px rgba(255, 95, 87, 0.14);
}

.arena-status strong {
  color: rgba(21, 32, 51, 0.82);
  font-size: 12px;
  font-weight: 950;
}

.arena-status p {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.52);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 22px;
  outline: none;
}

.audit-gallery:focus-visible {
  box-shadow:
    0 0 0 3px rgba(121, 99, 255, 0.18),
    0 18px 44px rgba(121, 99, 255, 0.1);
}

.audit-gallery-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.audit-gallery-heading p,
.audit-gallery-heading h2,
.audit-gallery-heading span {
  margin: 0;
}

.audit-gallery-heading p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.audit-gallery-heading h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 19px;
  font-weight: 950;
  line-height: 1.1;
}

.audit-gallery-heading span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.56);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.42;
}

.audit-gallery-heading button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.56);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62);
  cursor: pointer;
  font-size: 11px;
  font-weight: 900;
}

.audit-gallery-heading-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.audit-gallery-sync {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.42);
}

.audit-gallery-sync p,
.audit-gallery-sync h3,
.audit-gallery-sync span {
  margin: 0;
}

.audit-gallery-sync p {
  color: rgba(97, 80, 220, 0.72);
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.audit-gallery-sync h3 {
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.86);
  font-size: 14px;
  font-weight: 950;
  line-height: 1.15;
}

.audit-gallery-sync span {
  display: block;
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.54);
  font-size: 11px;
  font-weight: 740;
  line-height: 1.38;
}

.audit-gallery-sync textarea {
  min-height: 138px;
  resize: vertical;
  padding: 11px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 14px;
  color: rgba(21, 32, 51, 0.72);
  background: rgba(255, 255, 255, 0.5);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 680;
  line-height: 1.45;
  outline: none;
}

.audit-gallery-sync textarea:focus {
  border-color: rgba(121, 99, 255, 0.34);
  box-shadow: 0 0 0 3px rgba(121, 99, 255, 0.12);
}

.audit-gallery-sync-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.audit-gallery-sync-actions button {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(121, 99, 255, 0.16);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.52);
  cursor: pointer;
  font-size: 10px;
  font-weight: 900;
}

.audit-gallery-sync-status {
  padding: 8px 10px;
  border: 1px solid rgba(22, 163, 104, 0.16);
  border-radius: 12px;
  color: #128a59;
  background: rgba(224, 255, 242, 0.42);
  font-size: 11px;
  font-weight: 850;
}

.audit-gallery-sync-status.error {
  border-color: rgba(200, 50, 50, 0.16);
  color: #c83232;
  background: rgba(255, 235, 235, 0.52);
}

.audit-gallery-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.audit-gallery-controls input {
  min-width: 0;
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.78);
  background: rgba(255, 255, 255, 0.48);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.64);
  font-size: 12px;
  font-weight: 760;
  outline: none;
}

.audit-gallery-controls input::placeholder {
  color: rgba(21, 32, 51, 0.38);
}

.audit-gallery-filters {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.audit-gallery-filters button {
  min-height: 32px;
  padding: 0 11px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: rgba(97, 80, 220, 0.76);
  background: rgba(255, 255, 255, 0.42);
  font-size: 10px;
  font-weight: 900;
  cursor: pointer;
}

.audit-gallery-filters button.active {
  border-color: rgba(121, 99, 255, 0.32);
  color: #ffffff;
  background: linear-gradient(135deg, rgba(121, 99, 255, 0.9), rgba(80, 167, 255, 0.74));
  box-shadow: 0 12px 26px rgba(121, 99, 255, 0.16);
}

.audit-gallery-advanced-filters {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.audit-gallery-advanced-filters select {
  min-width: 0;
  min-height: 34px;
  padding: 0 11px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 12px;
  color: rgba(21, 32, 51, 0.72);
  background: rgba(255, 255, 255, 0.48);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62);
  font-size: 11px;
  font-weight: 820;
  outline: none;
}

.audit-gallery-error,
.audit-gallery-empty {
  padding: 11px 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 16px;
  color: rgba(21, 32, 51, 0.58);
  background: rgba(255, 255, 255, 0.42);
  font-size: 12px;
  font-weight: 780;
}

.audit-gallery-error {
  border-color: rgba(220, 60, 103, 0.22);
  color: rgba(190, 28, 70, 0.88);
}

.audit-gallery-layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.72fr) minmax(0, 1.28fr);
  gap: 12px;
  min-width: 0;
}

.audit-gallery-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  max-height: 430px;
  overflow: auto;
}

.audit-gallery-entry {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 11px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.42);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.audit-gallery-entry.active,
.audit-gallery-entry.comparing,
.audit-gallery-entry:hover {
  border-color: rgba(121, 99, 255, 0.34);
  background: rgba(255, 255, 255, 0.62);
  box-shadow: 0 14px 28px rgba(121, 99, 255, 0.1);
}

.audit-gallery-entry.comparing {
  border-color: rgba(22, 163, 104, 0.24);
}

.audit-gallery-entry.pinned {
  border-color: rgba(181, 121, 24, 0.28);
  box-shadow:
    0 12px 26px rgba(181, 121, 24, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.64);
}

.audit-gallery-entry.batch {
  border-color: rgba(80, 167, 255, 0.16);
}

.audit-gallery-entry.compare {
  border-color: rgba(157, 93, 255, 0.18);
}

.audit-gallery-entry > button:first-child {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  color: rgba(21, 32, 51, 0.66);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.audit-gallery-compare-button,
.audit-gallery-pin-button,
.audit-gallery-hide-button {
  width: max-content;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid rgba(121, 99, 255, 0.16);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  font-weight: 900;
  cursor: pointer;
}

.audit-gallery-pin-button {
  border-color: rgba(181, 121, 24, 0.2);
  color: #9a6415;
}

.audit-gallery-hide-button {
  border-color: rgba(21, 32, 51, 0.12);
  color: rgba(21, 32, 51, 0.58);
}

.audit-gallery-compare-button:disabled,
.audit-gallery-pin-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.audit-gallery-list strong,
.audit-gallery-list span,
.audit-gallery-list small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.audit-gallery-list strong {
  color: rgba(21, 32, 51, 0.88);
  font-size: 12px;
  font-weight: 950;
  white-space: nowrap;
}

.audit-gallery-list span {
  display: -webkit-box;
  color: rgba(21, 32, 51, 0.58);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.audit-gallery-list small {
  color: rgba(97, 80, 220, 0.62);
  font-size: 9px;
  font-weight: 850;
  white-space: nowrap;
}

.audit-gallery-preview {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 13px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.32)),
    rgba(255, 255, 255, 0.42);
}

.audit-gallery-preview-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

.audit-gallery-preview-head p,
.audit-gallery-preview-head h3,
.audit-gallery-preview-head span {
  margin: 0;
}

.audit-gallery-preview-head p {
  color: rgba(97, 80, 220, 0.66);
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.audit-gallery-preview-head h3 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 16px;
  font-weight: 950;
  line-height: 1.15;
}

.audit-gallery-preview-head span {
  display: block;
  margin-top: 6px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-preview-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.audit-gallery-preview-actions strong,
.audit-gallery-preview-actions button {
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.54);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.audit-gallery-preview-actions strong {
  color: #6150dc;
}

.audit-gallery-preview-actions button {
  color: #ffffff;
  background: linear-gradient(135deg, rgba(121, 99, 255, 0.94), rgba(80, 167, 255, 0.78));
  box-shadow: 0 12px 24px rgba(121, 99, 255, 0.16);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.audit-gallery-preview-actions button:hover,
.audit-gallery-preview-actions button:focus-visible {
  border-color: rgba(121, 99, 255, 0.32);
  outline: none;
  transform: translateY(-1px);
}

.audit-gallery-preview pre {
  max-height: 360px;
  margin: 0;
  overflow: auto;
  padding: 13px;
  border: 1px solid rgba(21, 32, 51, 0.08);
  border-radius: 16px;
  color: rgba(21, 32, 51, 0.76);
  background: rgba(255, 255, 255, 0.46);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.48;
  white-space: pre-wrap;
}

.audit-gallery-csv-preview {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(21, 32, 51, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.46);
}

.audit-gallery-csv-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.audit-gallery-csv-summary span,
.audit-gallery-csv-summary strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-csv-summary span {
  padding: 5px 8px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.48);
  font-size: 10px;
  font-weight: 950;
}

.audit-gallery-csv-summary strong {
  color: rgba(21, 32, 51, 0.62);
  font-size: 10px;
  font-weight: 850;
}

.audit-gallery-csv-scroll {
  max-height: 328px;
  overflow: auto;
  border: 1px solid rgba(121, 99, 255, 0.1);
  border-radius: 14px;
}

.audit-gallery-csv-preview table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
  font-size: 11px;
}

.audit-gallery-csv-preview th,
.audit-gallery-csv-preview td {
  padding: 9px 10px;
  border-bottom: 1px solid rgba(21, 32, 51, 0.07);
  color: rgba(21, 32, 51, 0.68);
  font-weight: 720;
  text-align: left;
  vertical-align: top;
}

.audit-gallery-csv-preview th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgba(250, 250, 255, 0.82);
}

.audit-gallery-csv-preview th button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 0;
  border: 0;
  color: rgba(97, 80, 220, 0.78);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.audit-gallery-csv-preview th button.active {
  color: #6150dc;
}

.audit-gallery-csv-preview th button:focus-visible {
  outline: 2px solid rgba(121, 99, 255, 0.32);
  outline-offset: 3px;
}

.audit-gallery-csv-preview tr:last-child td {
  border-bottom: 0;
}

.audit-gallery-pinned {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(181, 121, 24, 0.18);
  border-radius: 17px;
  background:
    radial-gradient(circle at 8% 12%, rgba(255, 191, 73, 0.14), transparent 44%),
    rgba(255, 255, 255, 0.38);
}

.audit-gallery-pinned p,
.audit-gallery-pinned h3,
.audit-gallery-pinned span {
  margin: 0;
}

.audit-gallery-pinned p {
  color: rgba(181, 121, 24, 0.82);
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.audit-gallery-pinned h3 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 15px;
  font-weight: 950;
  line-height: 1.18;
}

.audit-gallery-pinned span {
  display: block;
  margin-top: 6px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-pinned button {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(181, 121, 24, 0.2);
  border-radius: 999px;
  color: #9a6415;
  background: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  font-weight: 950;
  cursor: pointer;
}

.audit-gallery-compare {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 17px;
  background:
    radial-gradient(circle at 12% 10%, rgba(121, 99, 255, 0.12), transparent 42%),
    rgba(255, 255, 255, 0.36);
}

.audit-gallery-compare-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
}

.audit-gallery-compare-head button {
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.52);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.64);
  cursor: pointer;
  font-size: 10px;
  font-weight: 950;
  white-space: nowrap;
}

.audit-gallery-compare-head button:disabled {
  cursor: wait;
  opacity: 0.66;
}

.audit-gallery-compare-head p,
.audit-gallery-compare-head h3,
.audit-gallery-compare-head span,
.audit-gallery-compare-export-status strong,
.audit-gallery-compare-export-status span,
.audit-gallery-compare-row span,
.audit-gallery-compare-row strong,
.audit-gallery-compare-row p {
  margin: 0;
}

.audit-gallery-compare-head p {
  color: rgba(97, 80, 220, 0.66);
  font-size: 10px;
  font-weight: 950;
  text-transform: uppercase;
}

.audit-gallery-compare-head h3 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 15px;
  font-weight: 950;
  line-height: 1.18;
}

.audit-gallery-compare-head span {
  display: block;
  margin-top: 6px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.48);
  font-size: 10px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-compare-export-status {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid rgba(27, 148, 99, 0.16);
  border-radius: 14px;
  color: rgba(20, 115, 78, 0.88);
  background: rgba(236, 255, 247, 0.52);
}

.audit-gallery-compare-export-status.error {
  border-color: rgba(220, 60, 103, 0.22);
  color: rgba(190, 28, 70, 0.88);
  background: rgba(255, 239, 244, 0.5);
}

.audit-gallery-compare-export-status strong {
  font-size: 11px;
  font-weight: 950;
}

.audit-gallery-compare-export-status span {
  overflow: hidden;
  font-size: 10px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-compare-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.audit-gallery-compare-row {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(121, 99, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.42);
}

.audit-gallery-compare-row span {
  color: rgba(21, 32, 51, 0.5);
  font-size: 9px;
  font-weight: 900;
  text-transform: uppercase;
}

.audit-gallery-compare-row strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 12px;
  font-weight: 950;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-gallery-compare-row p {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.54);
  font-size: 10px;
  font-weight: 720;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.audit-gallery-compare-row.aligned strong {
  color: #11935a;
}

.audit-gallery-compare-row.risk strong {
  color: #c83232;
}

.audit-replay-card {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 22px;
}

.quant-bridge-card {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 22px;
  background:
    radial-gradient(circle at 12% 18%, rgba(122, 92, 255, 0.16), transparent 34%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(245, 248, 255, 0.46)),
    rgba(255, 255, 255, 0.6);
}

.quant-bridge-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.quant-bridge-heading h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 24px;
  font-weight: 960;
  line-height: 1;
}

.quant-bridge-heading span {
  display: block;
  margin-top: 8px;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  font-weight: 760;
  line-height: 1.45;
}

.quant-bridge-heading > strong {
  padding: 8px 12px;
  border: 1px solid rgba(122, 92, 255, 0.2);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.56);
  font-size: 11px;
  font-weight: 950;
}

.quant-bridge-metrics,
.quant-bridge-pulse {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.quant-bridge-metrics span,
.quant-bridge-pulse span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 6px 9px;
  border: 1px solid rgba(122, 92, 255, 0.12);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.64);
  background: rgba(255, 255, 255, 0.48);
  font-size: 10px;
  font-weight: 850;
}

.quant-bridge-pulse b {
  color: rgba(21, 32, 51, 0.86);
  font-weight: 950;
}

.quant-bridge-pulse .tone-up b {
  color: #0f9f6e;
}

.quant-bridge-pulse .tone-down b {
  color: #dc3c67;
}

.quant-bridge-pulse .tone-warn b {
  color: #b57918;
}

.quant-bridge-batch-card {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 22px;
  background:
    radial-gradient(circle at 10% 12%, rgba(80, 167, 255, 0.16), transparent 34%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.76), rgba(245, 248, 255, 0.44)),
    rgba(255, 255, 255, 0.58);
}

.quant-bridge-batch-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.quant-bridge-batch-heading h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 19px;
  font-weight: 960;
  line-height: 1.05;
}

.quant-bridge-batch-heading span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.58);
  font-size: 12px;
  font-weight: 760;
  line-height: 1.45;
}

.quant-bridge-batch-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
  max-width: 310px;
}

.quant-bridge-batch-heading button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #ffffff;
  background:
    linear-gradient(135deg, rgba(121, 99, 255, 0.92), rgba(80, 167, 255, 0.78)),
    rgba(121, 99, 255, 0.86);
  box-shadow: 0 12px 28px rgba(121, 99, 255, 0.18);
  font-size: 11px;
  font-weight: 950;
  white-space: nowrap;
  cursor: pointer;
}

.quant-bridge-batch-heading button:disabled {
  cursor: progress;
  opacity: 0.68;
}

.quant-bridge-batch-error,
.quant-bridge-batch-export-status {
  padding: 9px 11px;
  border: 1px solid rgba(220, 60, 103, 0.22);
  border-radius: 16px;
  color: rgba(190, 28, 70, 0.88);
  background: rgba(255, 232, 238, 0.58);
  font-size: 11px;
  font-weight: 850;
}

.quant-bridge-batch-export-status {
  display: grid;
  gap: 4px;
  border-color: rgba(22, 163, 104, 0.2);
  color: rgba(15, 130, 88, 0.9);
  background: rgba(231, 255, 244, 0.58);
}

.quant-bridge-batch-export-status.error {
  border-color: rgba(220, 60, 103, 0.22);
  color: rgba(190, 28, 70, 0.88);
  background: rgba(255, 232, 238, 0.58);
}

.quant-bridge-batch-export-status strong {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 10px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quant-bridge-batch-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}

.quant-bridge-batch-row {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.64), rgba(255, 255, 255, 0.34)),
    rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.58);
  transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.quant-bridge-batch-row.active,
.quant-bridge-batch-row.running {
  border-color: rgba(121, 99, 255, 0.36);
  box-shadow:
    0 14px 30px rgba(121, 99, 255, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
}

.quant-bridge-batch-row.failed {
  border-color: rgba(220, 60, 103, 0.22);
}

.quant-bridge-batch-row.complete {
  border-color: rgba(22, 163, 104, 0.2);
}

.quant-bridge-batch-row span,
.quant-bridge-batch-row h3,
.quant-bridge-batch-row strong,
.quant-bridge-batch-row small,
.quant-bridge-batch-row p {
  margin: 0;
}

.quant-bridge-batch-row span {
  color: rgba(97, 80, 220, 0.68);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.quant-bridge-batch-row h3 {
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 17px;
  font-weight: 960;
  line-height: 1;
}

.quant-bridge-batch-row > strong {
  width: max-content;
  padding: 5px 8px;
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.52);
  font-size: 10px;
  font-weight: 950;
}

.quant-bridge-batch-row small {
  color: rgba(21, 32, 51, 0.56);
  font-size: 10px;
  font-weight: 820;
  line-height: 1.3;
}

.quant-bridge-batch-row p {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.62);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.audit-replay-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.audit-replay-heading h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
}

.audit-replay-heading span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.56);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.4;
}

.audit-replay-actions {
  display: grid;
  justify-items: end;
  gap: 8px;
}

.audit-replay-actions strong {
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.48);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.audit-replay-actions button {
  min-height: 30px;
  padding: 7px 11px;
  border: 1px solid rgba(121, 99, 255, 0.18);
  border-radius: 999px;
  color: #ffffff;
  background:
    linear-gradient(135deg, rgba(121, 99, 255, 0.92), rgba(80, 167, 255, 0.88)),
    rgba(121, 99, 255, 0.86);
  box-shadow:
    0 10px 26px rgba(121, 99, 255, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.34);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.audit-replay-actions button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    0 14px 30px rgba(121, 99, 255, 0.26),
    inset 0 1px 0 rgba(255, 255, 255, 0.42);
}

.audit-replay-actions button:disabled {
  cursor: progress;
  opacity: 0.72;
}

.audit-replay-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.audit-replay-source-tags,
.audit-replay-delta-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.audit-replay-tags span,
.audit-replay-source-tags span,
.audit-replay-delta-badges span {
  max-width: 100%;
  padding: 6px 8px;
  overflow: hidden;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.56);
  background: rgba(255, 255, 255, 0.42);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-replay-source-tags span {
  color: rgba(97, 80, 220, 0.72);
  background: rgba(255, 255, 255, 0.5);
}

.audit-replay-delta-badges span.aligned {
  border-color: rgba(22, 163, 104, 0.16);
  color: #128a59;
  background: rgba(224, 255, 242, 0.42);
}

.audit-replay-delta-badges span.watch {
  border-color: rgba(181, 121, 24, 0.18);
  color: #9a6415;
  background: rgba(255, 246, 225, 0.5);
}

.audit-replay-delta-badges span.risk {
  border-color: rgba(200, 50, 50, 0.16);
  color: #c83232;
  background: rgba(255, 235, 235, 0.52);
}

.audit-export-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid rgba(22, 163, 104, 0.18);
  border-radius: 16px;
  color: rgba(16, 115, 76, 0.92);
  background:
    linear-gradient(135deg, rgba(229, 255, 243, 0.7), rgba(255, 255, 255, 0.42)),
    rgba(255, 255, 255, 0.42);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62);
  font-size: 11px;
  font-weight: 850;
}

.audit-export-status.error {
  border-color: rgba(220, 60, 103, 0.22);
  color: rgba(190, 28, 70, 0.9);
  background:
    linear-gradient(135deg, rgba(255, 232, 238, 0.74), rgba(255, 255, 255, 0.42)),
    rgba(255, 255, 255, 0.42);
}

.audit-export-status strong {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 10px;
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-replay-contributions {
  display: grid;
  gap: 7px;
}

.advanced-settings-drawer {
  z-index: 5;
  display: grid;
  gap: 0;
  padding: 0;
  overflow: hidden;
  border-radius: 26px;
  pointer-events: none;
  scroll-margin: 128px 0 180px;
}

.advanced-settings-summary {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-width: 0;
  padding: 18px 20px;
  border: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  list-style: none;
  pointer-events: auto;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.advanced-settings-summary::after {
  display: grid;
  width: 28px;
  height: 28px;
  margin-left: 6px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  color: rgba(97, 80, 220, 0.86);
  background: rgba(255, 255, 255, 0.08);
  content: "⌄";
  font-size: 18px;
  font-weight: 900;
  line-height: 1;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.advanced-settings-drawer.open .advanced-settings-summary::after {
  transform: rotate(180deg);
}

.advanced-settings-summary:hover,
.advanced-settings-summary:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}

.advanced-settings-drawer p,
.advanced-settings-drawer h2,
.advanced-settings-drawer span,
.advanced-settings-drawer strong {
  margin: 0;
}

.advanced-settings-summary p {
  color: rgba(97, 80, 220, 0.78);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.advanced-settings-summary h2 {
  margin-top: 6px;
  color: rgba(15, 23, 42, 0.9);
  font-size: 17px;
  font-weight: 950;
  line-height: 1.1;
}

.advanced-settings-summary span {
  display: block;
  margin-top: 6px;
  color: rgba(15, 23, 42, 0.62);
  font-size: 12px;
  font-weight: 760;
  line-height: 1.4;
}

.advanced-settings-summary > strong {
  padding: 8px 11px;
  border: 1px solid rgba(121, 99, 255, 0.2);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.1);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.advanced-settings-content {
  display: grid;
  gap: 14px;
  padding: 0 16px 16px;
  pointer-events: auto;
}

.scenario-presets {
  z-index: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 22px;
}

.scenario-presets-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.scenario-presets-header h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
}

.scenario-presets-header span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.56);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.4;
}

.scenario-presets-header > strong {
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.48);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.scenario-preset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
  min-width: 0;
}

.scenario-preset-grid button {
  display: grid;
  gap: 7px;
  min-width: 0;
  min-height: 104px;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 18px;
  appearance: none;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.28)),
    rgba(255, 255, 255, 0.42);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.scenario-preset-grid button:hover,
.scenario-preset-grid button:focus-visible,
.scenario-preset-grid button.active {
  border-color: rgba(121, 99, 255, 0.38);
  box-shadow:
    0 14px 32px rgba(121, 99, 255, 0.13),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
  outline: none;
  transform: translateY(-1px);
}

.scenario-preset-grid button:disabled {
  cursor: wait;
  opacity: 0.64;
  transform: none;
}

.scenario-preset-grid strong {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.84);
  font-size: 13px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scenario-preset-grid span {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.54);
  font-size: 10px;
  font-weight: 720;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.scenario-preset-grid em {
  align-self: end;
  width: fit-content;
  padding: 5px 7px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 999px;
  color: rgba(97, 80, 220, 0.72);
  background: rgba(255, 255, 255, 0.42);
  font-size: 9px;
  font-style: normal;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.scenario-matrix {
  z-index: 1;
  display: grid;
  gap: 13px;
  padding: 16px;
  border-radius: 22px;
}

.scenario-matrix-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.scenario-matrix-header h2 {
  margin-top: 6px;
  color: rgba(21, 32, 51, 0.88);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
}

.scenario-matrix-header span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.56);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.4;
}

.scenario-matrix-header > strong {
  padding: 8px 12px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.48);
  font-size: 11px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.scenario-matrix-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.scenario-matrix-row {
  display: grid;
  gap: 11px;
  min-width: 0;
  padding: 13px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.28)),
    rgba(255, 255, 255, 0.42);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.scenario-matrix-row:hover,
.scenario-matrix-row.expanded {
  border-color: rgba(121, 99, 255, 0.34);
  box-shadow:
    0 14px 30px rgba(121, 99, 255, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
}

.scenario-matrix-row.active {
  border-color: rgba(121, 99, 255, 0.42);
  box-shadow:
    0 16px 34px rgba(121, 99, 255, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
  transform: translateY(-1px);
}

.scenario-matrix-row.buy {
  box-shadow: inset 0 2px 0 rgba(22, 163, 104, 0.28);
}

.scenario-matrix-row.sell {
  box-shadow: inset 0 2px 0 rgba(220, 60, 103, 0.26);
}

.scenario-matrix-row.hold {
  box-shadow: inset 0 2px 0 rgba(121, 99, 255, 0.24);
}

.scenario-matrix-title {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 9px;
}

.scenario-matrix-title span {
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.scenario-matrix-title h3 {
  margin-top: 5px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.86);
  font-size: 15px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scenario-matrix-title > strong {
  padding: 6px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.52);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
}

.scenario-matrix-title > strong.buy {
  color: #11935a;
}

.scenario-matrix-title > strong.sell {
  color: #c83232;
}

.scenario-matrix-title > strong.hold {
  color: #6150dc;
}

.scenario-matrix-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.scenario-matrix-metrics div {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 9px;
  border: 1px solid rgba(121, 99, 255, 0.1);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.4);
}

.scenario-matrix-metrics span {
  color: rgba(21, 32, 51, 0.4);
  font-size: 9px;
  font-weight: 950;
  line-height: 1;
  text-transform: uppercase;
}

.scenario-matrix-metrics strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 14px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scenario-matrix-metrics small {
  overflow: hidden;
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 780;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scenario-matrix-row > p {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.56);
  font-size: 11px;
  font-weight: 740;
  line-height: 1.42;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.scenario-drilldown {
  z-index: 1;
  display: grid;
  gap: 18px;
  width: min(1120px, 100%);
  min-width: 0;
  justify-self: center;
  padding: clamp(18px, 2.4vw, 26px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 30px;
  background:
    radial-gradient(circle at 16% 0%, rgba(121, 99, 255, 0.14), transparent 48%),
    rgba(255, 255, 255, 0.05);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.05),
    inset 0 0 44px rgba(121, 99, 255, 0.045);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.scenario-drilldown-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.scenario-drilldown-heading p,
.scenario-drilldown-heading h3,
.scenario-drilldown-heading span {
  margin: 0;
}

.scenario-drilldown-heading p {
  color: rgba(97, 80, 220, 0.7);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.scenario-drilldown-heading h3 {
  margin-top: 5px;
  color: rgba(21, 32, 51, 0.9);
  font-size: clamp(22px, 2.4vw, 32px);
  font-weight: 950;
  line-height: 1.1;
}

.scenario-drilldown-heading span {
  display: block;
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.56);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.42;
}

.scenario-drilldown-heading > strong {
  padding: 7px 10px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.54);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  white-space: nowrap;
}

.scenario-drilldown-heading > strong.sell {
  color: #c83232;
}

.scenario-drilldown-heading > strong.hold {
  color: #a56812;
}

.scenario-drilldown-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(12px, 2vw, 18px);
}

.scenario-drilldown-point {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.scenario-drilldown-point.macro {
  border-color: rgba(80, 167, 255, 0.2);
  box-shadow:
    inset 0 0 30px rgba(99, 102, 241, 0.045),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.scenario-drilldown-point.bull {
  border-color: rgba(22, 163, 104, 0.2);
  box-shadow:
    inset 0 0 30px rgba(16, 185, 129, 0.045),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.scenario-drilldown-point.bear {
  border-color: rgba(220, 60, 103, 0.2);
  box-shadow:
    inset 0 0 30px rgba(244, 63, 94, 0.045),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.scenario-drilldown-point span,
.scenario-drilldown-point strong,
.scenario-drilldown-point b,
.scenario-drilldown-point p {
  margin: 0;
}

.scenario-drilldown-point span {
  color: rgba(21, 32, 51, 0.42);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.scenario-drilldown-point strong {
  display: block;
  margin-top: 4px;
  color: rgba(21, 32, 51, 0.9);
  font-size: 18px;
  font-weight: 950;
  line-height: 1.05;
}

.scenario-drilldown-point b {
  width: max-content;
  padding: 5px 8px;
  border-radius: 999px;
  color: #6150dc;
  background: rgba(255, 255, 255, 0.56);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
}

.scenario-drilldown-point p {
  color: rgba(21, 32, 51, 0.62);
  font-size: 11px;
  font-weight: 740;
  line-height: 1.42;
}

.agent-grid {
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(3, minmax(300px, 1fr));
  align-items: stretch;
  gap: clamp(22px, 2.8vw, 36px);
  width: min(1560px, 100%);
  justify-self: center;
  margin-top: clamp(10px, 2vh, 24px);
}

.agent-card {
  display: grid;
  grid-template-rows: auto auto minmax(180px, 1fr) auto;
  align-content: start;
  gap: clamp(16px, 1.8vw, 22px);
  min-width: 0;
  min-height: clamp(500px, 58vh, 680px);
  padding: clamp(22px, 2.2vw, 34px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  opacity: 0;
  transform: translateY(18px) scale(0.985);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.agent-card.visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.agent-card.macro {
  box-shadow:
    inset 0 0 40px rgba(99, 102, 241, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.agent-card.bull {
  box-shadow:
    inset 0 0 40px rgba(16, 185, 129, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.agent-card.bear {
  box-shadow:
    inset 0 0 40px rgba(244, 63, 94, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.05);
}

.agent-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.agent-header,
.agent-stats,
.agent-content,
.agent-points span {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.agent-avatar {
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow:
    0 18px 42px rgba(15, 23, 42, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  font-size: 32px;
}

.macro .agent-avatar {
  box-shadow:
    inset 0 0 26px rgba(99, 102, 241, 0.12),
    0 18px 42px rgba(99, 102, 241, 0.12);
}

.bull .agent-avatar {
  box-shadow:
    inset 0 0 26px rgba(16, 185, 129, 0.12),
    0 18px 42px rgba(16, 185, 129, 0.12);
}

.bear .agent-avatar {
  box-shadow:
    inset 0 0 26px rgba(244, 63, 94, 0.12),
    0 18px 42px rgba(244, 63, 94, 0.12);
}

.agent-header h2 {
  margin-top: 6px;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.88);
  font-size: 22px;
  font-weight: 950;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-stats,
.verdict-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.agent-stats article,
.verdict-metrics article {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px;
  border: 1px solid rgba(121, 99, 255, 0.12);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.48);
}

.agent-stats span,
.verdict-metrics span {
  color: rgba(21, 32, 51, 0.44);
  font-size: 10px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.agent-stats strong,
.verdict-metrics strong {
  overflow: hidden;
  color: #6150dc;
  font-size: 18px;
  font-weight: 950;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-content {
  position: relative;
  min-height: 0;
  max-height: clamp(190px, 28vh, 310px);
  padding: 18px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 22px;
  color: rgba(21, 32, 51, 0.66);
  background: rgba(255, 255, 255, 0.08);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.035),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  font-size: 15px;
  font-weight: 760;
  line-height: 1.68;
  scrollbar-width: thin;
  scrollbar-color: rgba(121, 99, 255, 0.26) transparent;
  transition:
    max-height 0.4s ease,
    border-color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.agent-content::before {
  position: absolute;
  top: 14px;
  left: 14px;
  color: rgba(121, 99, 255, 0.2);
  content: "“";
  font-size: 34px;
  font-weight: 950;
  line-height: 1;
  transform: translate(-3px, -8px);
}

.agent-content::after {
  position: sticky;
  bottom: -18px;
  display: block;
  height: 34px;
  margin: 8px -18px -18px;
  pointer-events: none;
  content: "";
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0), rgba(247, 250, 255, 0.42));
  opacity: 1;
  transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.agent-card:hover .agent-content,
.agent-card:focus-within .agent-content {
  max-height: 800px;
}

.agent-card:hover .agent-content::after,
.agent-card:focus-within .agent-content::after {
  opacity: 0;
}

.agent-reasoning-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 4px 0 0 20px;
}

.agent-reasoning-list li {
  padding-left: 2px;
  color: rgba(21, 32, 51, 0.68);
}

.agent-reasoning-list li::marker {
  color: rgba(121, 99, 255, 0.44);
}

.agent-reasoning-list.macro li::marker {
  color: rgba(99, 102, 241, 0.72);
}

.agent-reasoning-list.bull li::marker {
  color: rgba(16, 185, 129, 0.78);
}

.agent-reasoning-list.bear li::marker {
  color: rgba(244, 63, 94, 0.78);
}

.reasoning-highlight {
  font-weight: 950;
}

.reasoning-highlight.macro {
  color: #4f46e5;
}

.reasoning-highlight.bull {
  color: #059669;
}

.reasoning-highlight.bear {
  color: #dc244d;
}

.agent-content::-webkit-scrollbar {
  width: 7px;
}

.agent-content::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(121, 99, 255, 0.24);
}

.agent-points {
  display: flex;
  flex-wrap: wrap;
  align-self: end;
  gap: 8px;
  margin-top: auto;
}

.agent-points span {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 7px 10px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  color: rgba(21, 32, 51, 0.56);
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  font-weight: 850;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card.visible .agent-header,
.agent-card.visible .agent-stats,
.agent-card.visible .agent-content,
.agent-card.visible .agent-points span {
  animation: agentFadeInUp 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
}

.agent-card.visible .agent-header {
  animation-delay: 30ms;
}

.agent-card.visible .agent-stats {
  animation-delay: 90ms;
}

.agent-card.visible .agent-content {
  animation-delay: 150ms;
}

.agent-card.visible .agent-points span:nth-child(1) {
  animation-delay: 210ms;
}

.agent-card.visible .agent-points span:nth-child(2) {
  animation-delay: 270ms;
}

.agent-card.visible .agent-points span:nth-child(3) {
  animation-delay: 330ms;
}

.agent-card.visible .agent-points span:nth-child(n + 4) {
  animation-delay: 390ms;
}

.verdict-panel {
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(360px, 1fr);
  align-items: center;
  gap: clamp(18px, 3vw, 32px);
  width: min(1060px, 100%);
  justify-self: center;
  margin: clamp(8px, 1.8vh, 18px) 0 clamp(32px, 5vh, 72px);
  padding: clamp(24px, 3vw, 34px);
  border: 1px solid rgba(16, 185, 129, 0.28);
  border-radius: 34px;
  background:
    radial-gradient(circle at 78% 28%, rgba(16, 185, 129, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.16), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 28px 86px rgba(16, 185, 129, 0.12),
    inset 0 0 56px rgba(16, 185, 129, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  opacity: 0;
  transform: translateY(20px);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.verdict-panel.buy {
  border-color: rgba(16, 185, 129, 0.4);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(16, 185, 129, 0.16),
    inset 0 0 64px rgba(16, 185, 129, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.verdict-panel.hold {
  border-color: rgba(121, 99, 255, 0.4);
  background:
    radial-gradient(circle at 78% 28%, rgba(121, 99, 255, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.16), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(121, 99, 255, 0.16),
    inset 0 0 64px rgba(121, 99, 255, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.verdict-panel.sell {
  border-color: rgba(244, 63, 94, 0.4);
  background:
    radial-gradient(circle at 78% 28%, rgba(244, 63, 94, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.16), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(244, 63, 94, 0.16),
    inset 0 0 64px rgba(244, 63, 94, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.verdict-panel.visible {
  animation: verdictFadeInUp 0.38s cubic-bezier(0.4, 0, 0.2, 1) both;
  opacity: 1;
  transform: translateY(0);
}

.verdict-copy h2 {
  margin-top: 7px;
  color: rgba(21, 32, 51, 0.9);
  font-size: clamp(34px, 5vw, 58px);
  font-weight: 950;
  line-height: 1;
}

.verdict-scenario-grid {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.verdict-scenario-card {
  display: grid;
  grid-template-columns: minmax(92px, 0.28fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.verdict-scenario-card.bullish {
  border-color: rgba(16, 185, 129, 0.24);
}

.verdict-scenario-card.neutral {
  border-color: rgba(99, 102, 241, 0.24);
}

.verdict-scenario-card.bearish {
  border-color: rgba(244, 63, 94, 0.24);
}

.verdict-scenario-card div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.verdict-scenario-card span,
.verdict-scenario-card p,
.verdict-scenario-card small,
.verdict-json-fallback {
  margin: 0;
}

.verdict-scenario-card span {
  color: rgba(21, 32, 51, 0.46);
  font-size: 9px;
  font-weight: 950;
  line-height: 1.1;
  text-transform: uppercase;
}

.verdict-scenario-card strong {
  color: rgba(21, 32, 51, 0.9);
  font-size: 20px;
  font-weight: 950;
  line-height: 1;
}

.verdict-scenario-card.bullish strong {
  color: #059669;
}

.verdict-scenario-card.neutral strong {
  color: #4f46e5;
}

.verdict-scenario-card.bearish strong {
  color: #dc244d;
}

.verdict-scenario-card p {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(21, 32, 51, 0.62);
  font-size: 12px;
  font-weight: 740;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.verdict-scenario-card small {
  color: rgba(21, 32, 51, 0.46);
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
  white-space: nowrap;
}

.verdict-json-fallback {
  max-height: 150px;
  margin-top: 16px;
  padding: 12px;
  overflow: auto;
  border: 1px solid rgba(244, 63, 94, 0.2);
  border-radius: 16px;
  color: rgba(21, 32, 51, 0.66);
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.45;
  white-space: pre-wrap;
}

.verdict-metrics {
  grid-template-columns: minmax(180px, 1.2fr) repeat(2, minmax(120px, 0.7fr));
}

.verdict-action-card {
  min-height: 154px;
  justify-items: center;
  align-content: center;
  gap: 12px;
  border-color: rgba(16, 185, 129, 0.28);
  background:
    radial-gradient(circle at 50% 0%, rgba(16, 185, 129, 0.22), transparent 64%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 20px 54px rgba(16, 185, 129, 0.16),
    inset 0 0 44px rgba(16, 185, 129, 0.1);
}

.verdict-action-card.hold {
  border-color: rgba(121, 99, 255, 0.28);
  background:
    radial-gradient(circle at 50% 0%, rgba(121, 99, 255, 0.22), transparent 64%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 20px 54px rgba(121, 99, 255, 0.16),
    inset 0 0 44px rgba(121, 99, 255, 0.1);
}

.verdict-action-card.sell {
  border-color: rgba(244, 63, 94, 0.28);
  background:
    radial-gradient(circle at 50% 0%, rgba(244, 63, 94, 0.22), transparent 64%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 20px 54px rgba(244, 63, 94, 0.16),
    inset 0 0 44px rgba(244, 63, 94, 0.1);
}

.verdict-action-card strong {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: clamp(170px, 18vw, 260px);
  min-height: clamp(86px, 9vw, 124px);
  padding: 0 clamp(24px, 3vw, 38px);
  border-radius: 999px;
  font-size: clamp(58px, 7.6vw, 104px);
  line-height: 0.9;
  letter-spacing: 0;
  text-align: center;
  text-shadow: 0 0 24px rgba(255, 255, 255, 0.34);
}

.verdict-metrics strong.buy {
  color: #052e1b;
  background: linear-gradient(135deg, #a7f3d0, #34d399 42%, #10b981);
  box-shadow:
    0 0 46px rgba(16, 185, 129, 0.46),
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -12px 34px rgba(5, 46, 27, 0.16);
}

.verdict-metrics strong.hold {
  color: #24105f;
  background: linear-gradient(135deg, #ddd6fe, #a78bfa 45%, #7c3aed);
  box-shadow:
    0 0 46px rgba(121, 99, 255, 0.42),
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    inset 0 -12px 34px rgba(36, 16, 95, 0.18);
}

.verdict-metrics strong.sell {
  color: #4c0519;
  background: linear-gradient(135deg, #fecdd3, #fb7185 44%, #e11d48);
  box-shadow:
    0 0 46px rgba(244, 63, 94, 0.46),
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    inset 0 -12px 34px rgba(76, 5, 25, 0.18);
}

.mirofish-arena :is(
  .audit-gallery-sync,
  .audit-gallery-sync textarea,
  .audit-gallery-controls input,
  .audit-gallery-advanced-filters select,
  .audit-gallery-filters button,
  .audit-gallery-entry,
  .audit-gallery-preview,
  .audit-gallery-preview pre,
  .audit-gallery-csv-preview,
  .audit-gallery-csv-scroll,
  .audit-gallery-pinned,
  .audit-gallery-compare,
  .audit-gallery-compare-row,
  .audit-gallery-error,
  .audit-gallery-empty,
  .audit-replay-actions strong,
  .audit-replay-tags span,
  .audit-replay-source-tags span,
  .audit-replay-delta-badges span,
  .audit-export-status,
  .quant-bridge-metrics span,
  .quant-bridge-pulse span,
  .quant-bridge-batch-row,
  .quant-bridge-batch-export-status,
  .scenario-preset-grid button,
  .scenario-matrix-row,
  .scenario-matrix-metrics div,
  .decision-timeline-empty,
  .decision-timeline-item,
  .decision-pin-button,
  .pinned-baseline,
  .pinned-baseline-tags span,
  .baseline-alerts,
  .baseline-score,
  .baseline-score-contribution,
  .baseline-alert,
  .archive-empty,
  .archive-entry,
  .archive-detail,
  .archive-detail-metrics article,
  .archive-replay-card,
  .archive-compare,
  .compare-row,
  .agent-stats article,
  .verdict-scenario-card,
  .verdict-json-fallback,
  .verdict-metrics article:not(.verdict-action-card)
) {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
  }

  50% {
    transform: scale(1.3);
  }
}

@keyframes agentFadeInUp {
  from {
    opacity: 0;
    filter: blur(3px);
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }
}

@keyframes verdictFadeInUp {
  from {
    opacity: 0;
    filter: blur(4px);
    transform: translateY(20px);
  }

  to {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }
}

:global(.dark) .mirofish-arena {
  background:
    radial-gradient(780px 420px at 12% 4%, rgba(49, 91, 156, 0.24), transparent 62%),
    radial-gradient(760px 460px at 86% 10%, rgba(115, 34, 56, 0.2), transparent 64%),
    rgba(10, 13, 20, 0.64);
}

:global(.dark) .arena-hero,
:global(.dark) .arena-status,
:global(.dark) .audit-gallery,
:global(.dark) .audit-gallery-entry,
:global(.dark) .audit-gallery-preview,
:global(.dark) .audit-gallery-preview pre,
:global(.dark) .audit-gallery-sync,
:global(.dark) .audit-gallery-sync textarea,
:global(.dark) .audit-gallery-sync-actions button,
:global(.dark) .audit-gallery-csv-preview,
:global(.dark) .audit-gallery-csv-scroll,
:global(.dark) .audit-gallery-heading button,
:global(.dark) .audit-gallery-controls input,
:global(.dark) .audit-gallery-advanced-filters select,
:global(.dark) .audit-gallery-filters button,
:global(.dark) .audit-gallery-compare-button,
:global(.dark) .audit-gallery-pin-button,
:global(.dark) .audit-gallery-hide-button,
:global(.dark) .audit-gallery-preview-actions strong,
:global(.dark) .audit-gallery-preview-actions button,
:global(.dark) .audit-gallery-pinned,
:global(.dark) .audit-gallery-pinned button,
:global(.dark) .audit-gallery-compare,
:global(.dark) .audit-gallery-compare-head button,
:global(.dark) .audit-gallery-compare-export-status,
:global(.dark) .audit-gallery-compare-row,
:global(.dark) .audit-gallery-error,
:global(.dark) .audit-gallery-empty,
:global(.dark) .audit-replay-card,
:global(.dark) .audit-replay-actions strong,
:global(.dark) .audit-replay-tags span,
:global(.dark) .audit-replay-source-tags span,
:global(.dark) .audit-replay-delta-badges span,
:global(.dark) .audit-export-status,
:global(.dark) .quant-bridge-card,
:global(.dark) .quant-bridge-batch-card,
:global(.dark) .quant-bridge-batch-row,
:global(.dark) .quant-bridge-batch-row > strong,
:global(.dark) .quant-bridge-batch-export-status,
:global(.dark) .quant-bridge-metrics span,
:global(.dark) .quant-bridge-pulse span,
:global(.dark) .scenario-presets,
:global(.dark) .advanced-settings-drawer,
:global(.dark) .advanced-settings-summary > strong,
:global(.dark) .scenario-preset-grid button,
:global(.dark) .scenario-presets-header > strong,
:global(.dark) .scenario-preset-grid em,
:global(.dark) .scenario-matrix,
:global(.dark) .scenario-matrix-row,
:global(.dark) .scenario-matrix-metrics div,
:global(.dark) .scenario-matrix-title > strong,
:global(.dark) .scenario-matrix-header > strong,
:global(.dark) .scenario-drilldown,
:global(.dark) .scenario-drilldown-point,
:global(.dark) .scenario-drilldown-heading > strong,
:global(.dark) .scenario-drilldown-point b,
:global(.dark) .decision-timeline-panel,
:global(.dark) .decision-timeline-empty,
:global(.dark) .decision-timeline-item,
:global(.dark) .decision-timeline-tags span,
:global(.dark) .decision-pin-button,
:global(.dark) .pinned-baseline,
:global(.dark) .pinned-baseline-tags span,
:global(.dark) .pinned-baseline-header button,
:global(.dark) .baseline-alerts,
:global(.dark) .baseline-score,
:global(.dark) .baseline-score-contribution,
:global(.dark) .baseline-alert,
:global(.dark) .archive-panel,
:global(.dark) .agent-card,
:global(.dark) .verdict-panel,
:global(.dark) .agent-avatar,
:global(.dark) .agent-stats article,
:global(.dark) .verdict-metrics article,
:global(.dark) .archive-empty,
:global(.dark) .archive-entry,
:global(.dark) .archive-detail,
:global(.dark) .archive-detail-metrics article,
:global(.dark) .archive-replay-card,
:global(.dark) .replay-icon,
:global(.dark) .archive-compare,
:global(.dark) .compare-row,
:global(.dark) .agent-points span {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(16, 20, 30, 0.72);
}

:global(.dark) .arena-hero,
:global(.dark) .arena-status,
:global(.dark) .audit-gallery,
:global(.dark) .audit-replay-card,
:global(.dark) .quant-bridge-card,
:global(.dark) .quant-bridge-batch-card,
:global(.dark) .advanced-settings-drawer,
:global(.dark) .scenario-presets,
:global(.dark) .scenario-matrix,
:global(.dark) .decision-timeline-panel,
:global(.dark) .archive-panel,
:global(.dark) .verdict-panel {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

:global(.dark) .verdict-panel.buy {
  border-color: rgba(16, 185, 129, 0.4);
  background:
    radial-gradient(circle at 78% 28%, rgba(16, 185, 129, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.1), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(16, 185, 129, 0.16),
    inset 0 0 64px rgba(16, 185, 129, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

:global(.dark) .verdict-panel.hold {
  border-color: rgba(121, 99, 255, 0.4);
  background:
    radial-gradient(circle at 78% 28%, rgba(121, 99, 255, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.1), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(121, 99, 255, 0.16),
    inset 0 0 64px rgba(121, 99, 255, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

:global(.dark) .verdict-panel.sell {
  border-color: rgba(244, 63, 94, 0.4);
  background:
    radial-gradient(circle at 78% 28%, rgba(244, 63, 94, 0.18), transparent 46%),
    radial-gradient(circle at 10% 4%, rgba(255, 255, 255, 0.1), transparent 54%),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 -10px 40px rgba(0, 0, 0, 0.15),
    0 30px 92px rgba(244, 63, 94, 0.16),
    inset 0 0 64px rgba(244, 63, 94, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

:global(.dark) .mirofish-arena :is(
  .audit-gallery-entry,
  .audit-gallery-preview,
  .audit-gallery-sync,
  .audit-gallery-csv-preview,
  .audit-gallery-csv-scroll,
  .audit-gallery-pinned,
  .audit-gallery-compare,
  .audit-gallery-compare-row,
  .audit-replay-tags span,
  .audit-replay-source-tags span,
  .audit-replay-delta-badges span,
  .quant-bridge-metrics span,
  .quant-bridge-pulse span,
  .quant-bridge-batch-row,
  .scenario-preset-grid button,
  .scenario-matrix-row,
  .scenario-matrix-metrics div,
  .scenario-drilldown,
  .scenario-drilldown-point,
  .decision-timeline-item,
  .pinned-baseline,
  .baseline-alerts,
  .baseline-score,
  .baseline-score-contribution,
  .baseline-alert,
  .archive-entry,
  .archive-detail,
  .archive-detail-metrics article,
  .archive-replay-card,
  .archive-compare,
  .compare-row,
  .agent-stats article,
  .verdict-metrics article:not(.verdict-action-card)
) {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
}

:global(.dark) .audit-gallery-preview-actions strong {
  color: rgba(190, 203, 255, 0.92);
}

:global(.dark) .audit-gallery-preview-actions button {
  color: #ffffff;
  background: linear-gradient(135deg, rgba(121, 99, 255, 0.88), rgba(80, 167, 255, 0.66));
}

:global(.dark) .agent-card {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

:global(.dark) .agent-card.macro {
  box-shadow:
    inset 0 0 40px rgba(99, 102, 241, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.18);
}

:global(.dark) .agent-card.bull {
  box-shadow:
    inset 0 0 40px rgba(16, 185, 129, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.18);
}

:global(.dark) .agent-card.bear {
  box-shadow:
    inset 0 0 40px rgba(244, 63, 94, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.18);
}

:global(.dark) .agent-content::after {
  background: linear-gradient(to bottom, rgba(16, 20, 30, 0), rgba(16, 20, 30, 0.72));
}

:global(.dark) .agent-card:hover .agent-content::after,
:global(.dark) .agent-card:focus-within .agent-content::after {
  opacity: 0;
}

:global(.dark) .reasoning-highlight.macro,
:global(.dark) .verdict-scenario-card.neutral strong {
  color: #a5b4fc;
}

:global(.dark) .reasoning-highlight.bull,
:global(.dark) .verdict-scenario-card.bullish strong {
  color: #6ee7b7;
}

:global(.dark) .reasoning-highlight.bear,
:global(.dark) .verdict-scenario-card.bearish strong {
  color: #fda4af;
}

:global(.dark) .arena-hero h1,
:global(.dark) .audit-gallery-heading h2,
:global(.dark) .audit-gallery-sync h3,
:global(.dark) .audit-gallery-list strong,
:global(.dark) .audit-gallery-preview-head h3,
:global(.dark) .audit-gallery-pinned h3,
:global(.dark) .audit-gallery-compare-head h3,
:global(.dark) .audit-gallery-compare-row strong,
:global(.dark) .audit-replay-heading h2,
:global(.dark) .quant-bridge-heading h2,
:global(.dark) .quant-bridge-batch-heading h2,
:global(.dark) .quant-bridge-batch-row h3,
:global(.dark) .advanced-settings-summary h2,
:global(.dark) .scenario-presets-header h2,
:global(.dark) .scenario-preset-grid strong,
:global(.dark) .scenario-matrix-header h2,
:global(.dark) .scenario-matrix-title h3,
:global(.dark) .scenario-matrix-metrics strong,
:global(.dark) .scenario-drilldown-heading h3,
:global(.dark) .scenario-drilldown-point strong,
:global(.dark) .decision-timeline-header h2,
:global(.dark) .decision-timeline-item h3,
:global(.dark) .pinned-baseline-header h3,
:global(.dark) .baseline-alerts-header h4,
:global(.dark) .baseline-score span,
:global(.dark) .baseline-score-contribution strong,
:global(.dark) .baseline-score-contribution b,
:global(.dark) .baseline-alert strong,
:global(.dark) .archive-header h2,
:global(.dark) .archive-detail h3,
:global(.dark) .archive-entry strong,
:global(.dark) .archive-replay-card h4,
:global(.dark) .compare-heading h4,
:global(.dark) .compare-row p,
:global(.dark) .agent-header h2,
:global(.dark) .verdict-copy h2,
:global(.dark) .arena-status strong {
  color: rgba(237, 243, 255, 0.92);
}

:global(.dark) .audit-gallery-csv-preview th {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(22, 27, 40, 0.94);
}

:global(.dark) .audit-gallery-csv-preview th button {
  color: rgba(190, 203, 255, 0.82);
}

:global(.dark) .audit-gallery-csv-preview th button.active {
  color: rgba(237, 243, 255, 0.96);
}

:global(.dark) .audit-gallery-csv-preview td {
  border-color: rgba(255, 255, 255, 0.08);
}

:global(.dark) .arena-hero span,
:global(.dark) .arena-status p,
:global(.dark) .audit-gallery-heading span,
:global(.dark) .audit-gallery-sync span,
:global(.dark) .audit-gallery-sync textarea,
:global(.dark) .audit-gallery-list span,
:global(.dark) .audit-gallery-list small,
:global(.dark) .audit-gallery-preview-head span,
:global(.dark) .audit-gallery-preview pre,
:global(.dark) .audit-gallery-csv-summary strong,
:global(.dark) .audit-gallery-csv-preview td,
:global(.dark) .audit-gallery-controls input,
:global(.dark) .audit-gallery-advanced-filters select,
:global(.dark) .audit-gallery-pinned span,
:global(.dark) .audit-gallery-compare-head span,
:global(.dark) .audit-gallery-compare-export-status span,
:global(.dark) .audit-gallery-compare-row span,
:global(.dark) .audit-gallery-compare-row p,
:global(.dark) .audit-gallery-empty,
:global(.dark) .audit-replay-heading span,
:global(.dark) .audit-replay-actions strong,
:global(.dark) .audit-replay-tags span,
:global(.dark) .audit-replay-source-tags span,
:global(.dark) .audit-export-status,
:global(.dark) .quant-bridge-heading span,
:global(.dark) .quant-bridge-heading > strong,
:global(.dark) .quant-bridge-batch-heading span,
:global(.dark) .quant-bridge-batch-export-status,
:global(.dark) .quant-bridge-batch-export-status strong,
:global(.dark) .quant-bridge-batch-row small,
:global(.dark) .quant-bridge-batch-row p,
:global(.dark) .quant-bridge-metrics span,
:global(.dark) .quant-bridge-pulse span,
:global(.dark) .quant-bridge-pulse b,
:global(.dark) .advanced-settings-summary span,
:global(.dark) .advanced-settings-summary > strong,
:global(.dark) .scenario-presets-header span,
:global(.dark) .scenario-presets-header > strong,
:global(.dark) .scenario-preset-grid span,
:global(.dark) .scenario-preset-grid em,
:global(.dark) .scenario-matrix-header span,
:global(.dark) .scenario-matrix-header > strong,
:global(.dark) .scenario-matrix-title span,
:global(.dark) .scenario-matrix-metrics span,
:global(.dark) .scenario-matrix-metrics small,
:global(.dark) .scenario-matrix-row > p,
:global(.dark) .scenario-drilldown-heading span,
:global(.dark) .scenario-drilldown-point span,
:global(.dark) .scenario-drilldown-point p,
:global(.dark) .decision-timeline-empty,
:global(.dark) .decision-timeline-item small,
:global(.dark) .decision-timeline-item p,
:global(.dark) .decision-timeline-tags span,
:global(.dark) .pinned-baseline-header span,
:global(.dark) .pinned-baseline-tags span,
:global(.dark) .baseline-score small,
:global(.dark) .baseline-score em,
:global(.dark) .baseline-score-contribution span,
:global(.dark) .baseline-score-contribution small,
:global(.dark) .baseline-score-contribution p,
:global(.dark) .baseline-alert span,
:global(.dark) .archive-empty,
:global(.dark) .archive-entry span,
:global(.dark) .archive-entry small,
:global(.dark) .archive-detail > div:first-child > span,
:global(.dark) .archive-detail-metrics span,
:global(.dark) .archive-snippets p,
:global(.dark) .archive-snippets small,
:global(.dark) .archive-replay-card span,
:global(.dark) .archive-replay-card small,
:global(.dark) .compare-heading span,
:global(.dark) .compare-row span,
:global(.dark) .agent-content,
:global(.dark) .agent-reasoning-list li,
:global(.dark) .verdict-copy span,
:global(.dark) .verdict-scenario-card span,
:global(.dark) .verdict-scenario-card p,
:global(.dark) .verdict-scenario-card small,
:global(.dark) .verdict-json-fallback,
:global(.dark) .agent-points span,
:global(.dark) .agent-stats span,
:global(.dark) .verdict-metrics span {
  color: rgba(237, 243, 255, 0.62);
}

@media (max-width: 980px) {
  .agent-grid,
  .scenario-preset-grid,
  .scenario-matrix-grid,
  .scenario-drilldown-grid,
  .audit-gallery-layout,
  .quant-bridge-batch-grid,
  .decision-timeline-list,
  .archive-grid,
  .verdict-panel {
    grid-template-columns: minmax(0, 1fr);
  }

  .archive-replay {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .compare-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pinned-baseline-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .verdict-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .mirofish-arena {
    padding: 14px 14px 72px;
  }

  .arena-hero {
    grid-template-columns: minmax(0, 1fr);
  }

  .quant-bridge-batch-heading {
    grid-template-columns: minmax(0, 1fr);
  }

  .quant-bridge-batch-actions {
    justify-content: flex-start;
    max-width: none;
  }

  .audit-gallery-compare-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-compare-head {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-heading {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-heading-actions {
    justify-content: flex-start;
  }

  .audit-gallery-preview-head {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-preview-actions {
    justify-content: flex-start;
  }

  .audit-gallery-controls {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-advanced-filters {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-gallery-filters {
    justify-content: flex-start;
  }

  .audit-gallery-csv-summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .arena-hero h1 {
    font-size: 30px;
  }

  .arena-status {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .arena-status p {
    grid-column: 1 / -1;
    white-space: normal;
  }

  .archive-header {
    grid-template-columns: minmax(0, 1fr);
  }

  .decision-timeline-header {
    grid-template-columns: minmax(0, 1fr);
  }

  .pinned-baseline-header {
    grid-template-columns: minmax(0, 1fr);
  }

  .archive-detail-metrics {
    grid-template-columns: minmax(0, 1fr);
  }

  .archive-replay {
    grid-template-columns: minmax(0, 1fr);
  }

  .compare-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .pinned-baseline-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .verdict-metrics,
  .agent-stats {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
