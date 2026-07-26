import { createHash } from 'node:crypto'

interface InviteAttemptEntry {
  failures: number
  windowStartedAt: number
  blockedUntil: number
}

export interface GroupChatInviteAttemptLimiterOptions {
  maxFailures?: number
  windowMs?: number
  lockMs?: number
  maxEntries?: number
  now?: () => number
}

export class GroupChatInviteAttemptLimiter {
  private readonly entries = new Map<string, InviteAttemptEntry>()
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly lockMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: GroupChatInviteAttemptLimiterOptions = {}) {
    this.maxFailures = Math.max(1, Math.trunc(options.maxFailures ?? 8))
    this.windowMs = Math.max(1, Math.trunc(options.windowMs ?? 60_000))
    this.lockMs = Math.max(1, Math.trunc(options.lockMs ?? 60_000))
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 4_096))
    this.now = options.now ?? Date.now
  }

  isAllowed(key: string): boolean {
    const now = this.now()
    const entry = this.entries.get(key)
    if (!entry) {
      this.removeExpiredEntries(now)
      return this.entries.size < this.maxEntries
    }
    if (entry.blockedUntil > now) return false
    if (now - entry.windowStartedAt >= this.windowMs) {
      this.entries.delete(key)
    }
    return true
  }

  recordFailure(key: string): void {
    const now = this.now()
    let entry = this.entries.get(key)
    if (!entry || now - entry.windowStartedAt >= this.windowMs) {
      if (!this.ensureCapacity(key, now)) return
      entry = { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      this.entries.set(key, entry)
    }
    entry.failures += 1
    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = now + this.lockMs
    }
  }

  private removeExpiredEntries(now: number): void {
    for (const [candidate, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.windowStartedAt >= this.windowMs) {
        this.entries.delete(candidate)
      }
    }
  }

  private ensureCapacity(key: string, now: number): boolean {
    if (this.entries.has(key) || this.entries.size < this.maxEntries) return true
    this.removeExpiredEntries(now)
    return this.entries.size < this.maxEntries
  }
}

export function groupChatInviteAttemptSubjectKey(
  authUserId: number | null | undefined,
  networkAddress: string | null | undefined,
  localSubjectId?: string | null,
): string {
  const normalizedLocalSubjectId = String(localSubjectId || '').trim()
  const subject = typeof authUserId === 'number' && Number.isInteger(authUserId) && authUserId > 0
    ? `auth:${authUserId}`
    : normalizedLocalSubjectId
      ? `local:${normalizedLocalSubjectId}`
      : `network:${networkAddress || 'unknown'}`
  return createHash('sha256')
    .update('group-chat-invite-attempt-v1\0', 'utf8')
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 32)
}
