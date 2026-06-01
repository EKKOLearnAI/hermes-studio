import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useAuroraIntentAuditStore, type AuroraIntentAuditStatus } from '@/stores/hermes/aurora-intent-audit'
import type { AuroraToolSecurityLevel } from '@/services/hermes/aurora/tool-registry'

export interface AuroraGovernanceConfirmationRequest {
  title: string
  description: string
  details?: string
  confirmLabel?: string
  cancelLabel?: string
  source?: string
  contextKey?: string
  auditInput?: string
  toolId?: string
  toolName?: string
  securityLevel?: AuroraToolSecurityLevel
  payload?: Record<string, unknown>
}

export interface AuroraGovernanceConfirmation extends Required<Omit<AuroraGovernanceConfirmationRequest, 'details' | 'source' | 'contextKey' | 'auditInput' | 'toolId' | 'toolName' | 'securityLevel' | 'payload'>> {
  id: string
  details: string
  source: string
  contextKey: string
  auditInput: string
  toolId?: string
  toolName?: string
  securityLevel?: AuroraToolSecurityLevel
  payload?: Record<string, unknown>
  requestedAt: string
}

function normalizeConfirmation(request: AuroraGovernanceConfirmationRequest): AuroraGovernanceConfirmation {
  return {
    id: `governance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: request.title,
    description: request.description,
    details: request.details || '',
    confirmLabel: request.confirmLabel || 'Confirm',
    cancelLabel: request.cancelLabel || 'Cancel',
    source: request.source || 'Aurora Governance',
    contextKey: request.contextKey || '',
    auditInput: request.auditInput || request.title,
    toolId: request.toolId,
    toolName: request.toolName,
    securityLevel: request.securityLevel,
    payload: request.payload,
    requestedAt: new Date().toISOString(),
  }
}

function governanceStatusLabel(status: AuroraIntentAuditStatus): string {
  switch (status) {
    case 'approval_queued':
      return 'Approval queued for human review.'
    case 'approval_approved':
      return 'Approval granted by user.'
    case 'approval_rejected':
      return 'Approval rejected by user.'
    case 'approval_expired':
      return 'Approval expired because the source request was cleared.'
    default:
      return status.replace(/_/g, ' ')
  }
}

export const useAuroraGovernanceStore = defineStore('aurora-governance', () => {
  const confirmationQueue = ref<AuroraGovernanceConfirmation[]>([])
  const lastDecision = ref<{
    id: string
    source: string
    approved: boolean
    decidedAt: string
  } | null>(null)
  const resolverQueue: Array<{
    id: string
    resolve: (approved: boolean) => void
  }> = []

  const activeConfirmation = computed(() => confirmationQueue.value[0] || null)
  const hasPendingConfirmation = computed(() => Boolean(activeConfirmation.value))
  const pendingCount = computed(() => confirmationQueue.value.length)

  function recordGovernanceAudit(
    confirmation: AuroraGovernanceConfirmation,
    status: Extract<AuroraIntentAuditStatus, 'approval_queued' | 'approval_approved' | 'approval_rejected' | 'approval_expired'>,
  ) {
    useAuroraIntentAuditStore().record({
      input: confirmation.auditInput,
      status,
      toolId: confirmation.toolId,
      toolName: confirmation.toolName || confirmation.source,
      securityLevel: confirmation.securityLevel,
      summary: governanceStatusLabel(status),
      payload: {
        ...(confirmation.payload || {}),
        governanceId: confirmation.id,
        contextKey: confirmation.contextKey,
        source: confirmation.source,
        title: confirmation.title,
        description: confirmation.description,
        details: confirmation.details,
        requestedAt: confirmation.requestedAt,
        decisionAt: new Date().toISOString(),
      },
    })
  }

  function resolveConfirmation(id: string, approved: boolean) {
    const resolverIndex = resolverQueue.findIndex(item => item.id === id)
    const [resolver] = resolverIndex >= 0 ? resolverQueue.splice(resolverIndex, 1) : []
    resolver?.resolve(approved)
  }

  function settleConfirmation(
    current: AuroraGovernanceConfirmation | undefined,
    approved: boolean,
    status: Extract<AuroraIntentAuditStatus, 'approval_approved' | 'approval_rejected' | 'approval_expired'>,
  ) {
    if (current) {
      lastDecision.value = {
        id: current.id,
        source: current.source,
        approved,
        decidedAt: new Date().toISOString(),
      }
      recordGovernanceAudit(current, status)
      resolveConfirmation(current.id, approved)
    }
  }

  function finalizeConfirmation(approved: boolean) {
    const current = confirmationQueue.value[0]

    confirmationQueue.value = confirmationQueue.value.slice(1)
    settleConfirmation(current, approved, approved ? 'approval_approved' : 'approval_rejected')
  }

  function requestConfirmation(request: AuroraGovernanceConfirmationRequest): Promise<boolean> {
    const confirmation = normalizeConfirmation(request)
    return new Promise(resolve => {
      resolverQueue.push({
        id: confirmation.id,
        resolve,
      })
      confirmationQueue.value = [
        ...confirmationQueue.value,
        confirmation,
      ]
      recordGovernanceAudit(confirmation, 'approval_queued')
    })
  }

  function cancelConfirmation(contextKey: string): boolean {
    if (!contextKey) return false
    const index = confirmationQueue.value.findIndex(item => item.contextKey === contextKey)
    if (index < 0) return false

    const nextQueue = [...confirmationQueue.value]
    const [cancelled] = nextQueue.splice(index, 1)
    confirmationQueue.value = nextQueue
    settleConfirmation(cancelled, false, 'approval_expired')
    return true
  }

  function confirmActive() {
    finalizeConfirmation(true)
  }

  function cancelActive() {
    finalizeConfirmation(false)
  }

  return {
    activeConfirmation,
    hasPendingConfirmation,
    pendingCount,
    lastDecision,
    requestConfirmation,
    cancelConfirmation,
    confirmActive,
    cancelActive,
  }
})
