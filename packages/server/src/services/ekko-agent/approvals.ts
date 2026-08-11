import type {
  AgentToolApprovalChoice,
  AgentToolApprovalRequest,
} from '../../../../ekko-agent/src'

interface PendingEkkoToolApproval {
  sessionId: string
  resolve: (choice: AgentToolApprovalChoice) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
  onResolved?: (choice: AgentToolApprovalChoice) => void
}

export interface WaitForEkkoToolApprovalOptions {
  sessionId: string
  signal?: AbortSignal
  onRequested: (request: AgentToolApprovalRequest) => void
  onResolved?: (choice: AgentToolApprovalChoice) => void
}

export interface EkkoToolApprovalResponse {
  handled: boolean
  resolved: boolean
  choice: AgentToolApprovalChoice
}

const pendingApprovals = new Map<string, PendingEkkoToolApproval>()

export function waitForEkkoToolApproval(
  request: AgentToolApprovalRequest,
  options: WaitForEkkoToolApprovalOptions,
): Promise<AgentToolApprovalChoice> {
  if (options.signal?.aborted) return Promise.resolve('deny')
  if (
    pendingApprovals.has(request.approvalId) ||
    [...pendingApprovals.values()].some(pending => pending.sessionId === options.sessionId)
  ) {
    return Promise.resolve('deny')
  }

  return new Promise((resolve) => {
    const finish = (choice: AgentToolApprovalChoice) => {
      const pending = pendingApprovals.get(request.approvalId)
      if (!pending) return
      pendingApprovals.delete(request.approvalId)
      clearTimeout(pending.timer)
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      pending.onResolved?.(choice)
      pending.resolve(choice)
    }
    const timer = setTimeout(() => finish('deny'), request.timeoutMs)
    timer.unref?.()
    const onAbort = () => finish('deny')
    pendingApprovals.set(request.approvalId, {
      sessionId: options.sessionId,
      resolve,
      timer,
      signal: options.signal,
      onAbort,
      onResolved: options.onResolved,
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      options.onRequested(request)
    } catch {
      finish('deny')
    }
  })
}

export function respondToEkkoToolApproval(
  sessionId: string,
  approvalId: string,
  rawChoice: unknown,
): EkkoToolApprovalResponse {
  const choice = normalizeChoice(rawChoice)
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return { handled: false, resolved: false, choice }
  if (pending.sessionId !== sessionId) return { handled: true, resolved: false, choice }

  pendingApprovals.delete(approvalId)
  clearTimeout(pending.timer)
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort)
  }
  pending.onResolved?.(choice)
  pending.resolve(choice)
  return { handled: true, resolved: true, choice }
}

export function denyPendingEkkoToolApprovals(sessionId?: string): number {
  const targets = [...pendingApprovals.entries()]
    .filter(([, pending]) => !sessionId || pending.sessionId === sessionId)
  for (const [approvalId, pending] of targets) {
    pendingApprovals.delete(approvalId)
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.onResolved?.('deny')
    pending.resolve('deny')
  }
  return targets.length
}

function normalizeChoice(value: unknown): AgentToolApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always'
    ? value
    : 'deny'
}
