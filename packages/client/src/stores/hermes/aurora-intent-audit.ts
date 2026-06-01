import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  clearAuroraIntentAudit,
  fetchAuroraIntentAudit,
  writeAuroraIntentAuditRecord,
} from '@/api/aurora/intent-audit'
import type { AuroraToolSecurityLevel } from '@/services/hermes/aurora/tool-registry'
import type { AuroraAppKind } from '@/stores/hermes/aurora-app-window'

export type AuroraIntentAuditStatus =
  | 'fallback'
  | 'approval_required'
  | 'approval_queued'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_expired'
  | 'completed'
  | 'app_opened'
  | 'rejected'
  | 'failed'

export interface AuroraIntentAuditRecord {
  id: string
  input: string
  status: AuroraIntentAuditStatus
  timestamp: string
  toolId?: string
  toolName?: string
  securityLevel?: AuroraToolSecurityLevel
  appKind?: AuroraAppKind
  summary?: string
  payload?: Record<string, unknown>
}

const STORAGE_KEY = 'aurora.intent-audit.records.v1'
const MAX_RECORDS = 50
const SYNC_LIMIT = 50

function makeId(): string {
  return `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isAuditStatus(value: unknown): value is AuroraIntentAuditStatus {
  return (
    value === 'fallback' ||
    value === 'approval_required' ||
    value === 'approval_queued' ||
    value === 'approval_approved' ||
    value === 'approval_rejected' ||
    value === 'approval_expired' ||
    value === 'completed' ||
    value === 'app_opened' ||
    value === 'rejected' ||
    value === 'failed'
  )
}

function normalizeStoredRecord(value: unknown): AuroraIntentAuditRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<AuroraIntentAuditRecord>
  if (
    typeof record.id !== 'string' ||
    typeof record.input !== 'string' ||
    typeof record.timestamp !== 'string' ||
    !isAuditStatus(record.status)
  ) {
    return null
  }

  return {
    id: record.id,
    input: record.input,
    status: record.status,
    timestamp: record.timestamp,
    toolId: typeof record.toolId === 'string' ? record.toolId : undefined,
    toolName: typeof record.toolName === 'string' ? record.toolName : undefined,
    securityLevel: record.securityLevel,
    appKind: record.appKind,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    payload: record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : undefined,
  }
}

function normalizeImportedRecords(value: unknown): AuroraIntentAuditRecord[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { records?: unknown }).records)
      ? (value as { records: unknown[] }).records
      : []

  return candidate
    .map(normalizeStoredRecord)
    .filter((record): record is AuroraIntentAuditRecord => Boolean(record))
}

function readStoredRecords(): AuroraIntentAuditRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeStoredRecord)
      .filter((record): record is AuroraIntentAuditRecord => Boolean(record))
      .slice(0, MAX_RECORDS)
  } catch {
    return []
  }
}

function persistRecords(records: AuroraIntentAuditRecord[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)))
  } catch {
    // Auditing should never block the chat or App Mode runtime.
  }
}

function sortRecords(records: AuroraIntentAuditRecord[]): AuroraIntentAuditRecord[] {
  return [...records].sort((left, right) =>
    (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0),
  )
}

function mergeRecords(
  current: AuroraIntentAuditRecord[],
  incoming: AuroraIntentAuditRecord[],
): AuroraIntentAuditRecord[] {
  const byId = new Map<string, AuroraIntentAuditRecord>()
  for (const record of [...current, ...incoming]) {
    byId.set(record.id, record)
  }
  return sortRecords([...byId.values()]).slice(0, MAX_RECORDS)
}

export const useAuroraIntentAuditStore = defineStore('aurora-intent-audit', () => {
  const records = ref<AuroraIntentAuditRecord[]>(readStoredRecords())
  const syncState = ref<'idle' | 'syncing' | 'synced' | 'offline' | 'error'>('idle')
  const lastSyncedAt = ref<string | null>(null)
  const recentRecords = computed(() => records.value.slice(0, 12))
  const latest = computed(() => records.value[0] || null)
  const isServerSynced = computed(() => syncState.value === 'synced')

  function setRecords(nextRecords: AuroraIntentAuditRecord[]) {
    records.value = sortRecords(nextRecords).slice(0, MAX_RECORDS)
    persistRecords(records.value)
  }

  async function persistRecordToServer(record: AuroraIntentAuditRecord) {
    try {
      await writeAuroraIntentAuditRecord(record)
      syncState.value = 'synced'
      lastSyncedAt.value = new Date().toISOString()
    } catch {
      syncState.value = 'offline'
    }
  }

  function record(entry: Omit<AuroraIntentAuditRecord, 'id' | 'timestamp'>) {
    const auditRecord: AuroraIntentAuditRecord = {
      ...entry,
      id: makeId(),
      timestamp: new Date().toISOString(),
    }
    setRecords([auditRecord, ...records.value])
    void persistRecordToServer(auditRecord)
    return auditRecord
  }

  function updateRecord(
    id: string,
    updater: (record: AuroraIntentAuditRecord) => AuroraIntentAuditRecord | null | undefined,
  ) {
    const current = records.value.find(record => record.id === id)
    if (!current) return null

    const next = updater(current)
    if (!next) return null

    const updated: AuroraIntentAuditRecord = {
      ...next,
      id: current.id,
      timestamp: current.timestamp,
    }
    setRecords(records.value.map(record => record.id === id ? updated : record))
    void persistRecordToServer(updated)
    return updated
  }

  function clear() {
    setRecords([])
    void clearAuroraIntentAudit()
      .then(() => {
        syncState.value = 'synced'
        lastSyncedAt.value = new Date().toISOString()
      })
      .catch(() => {
        syncState.value = 'offline'
      })
  }

  function hydrate() {
    setRecords(readStoredRecords())
  }

  function exportSnapshot() {
    return {
      exportedAt: new Date().toISOString(),
      source: 'Aurora OS Intent Audit',
      schemaVersion: 1,
      records: records.value,
    }
  }

  function importRecords(value: unknown): number {
    const imported = normalizeImportedRecords(value)
    if (imported.length === 0) return 0

    const merged = mergeRecords(records.value, imported)
    setRecords(merged)
    for (const record of imported.slice(0, SYNC_LIMIT)) {
      void persistRecordToServer(record)
    }
    return imported.length
  }

  async function syncFromServer() {
    if (syncState.value === 'syncing') return
    syncState.value = 'syncing'
    try {
      const response = await fetchAuroraIntentAudit(SYNC_LIMIT)
      setRecords(mergeRecords(records.value, response.records || []))
      syncState.value = 'synced'
      lastSyncedAt.value = response.generatedAt || new Date().toISOString()
    } catch {
      syncState.value = records.value.length > 0 ? 'offline' : 'error'
    }
  }

  return {
    records,
    syncState,
    lastSyncedAt,
    recentRecords,
    latest,
    isServerSynced,
    record,
    updateRecord,
    clear,
    hydrate,
    exportSnapshot,
    importRecords,
    syncFromServer,
  }
})
