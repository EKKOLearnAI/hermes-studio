import { createHmac, timingSafeEqual, randomUUID } from 'crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface FabricAuditCheckpoint {
  sequence: number
  hash: string
}

export interface FabricAuditAnchorState {
  committed: FabricAuditCheckpoint
  pending: { previous: FabricAuditCheckpoint; next: FabricAuditCheckpoint } | null
}

type StoredAnchor = FabricAuditAnchorState & { version: 1; mac: string }

export function getFabricAuditAnchorPath(directory: string): string {
  return join(directory, '.action-fabric-audit-anchor')
}

export function readFabricAuditAnchor(directory: string, key: Buffer): FabricAuditAnchorState | null {
  let encoded: string
  try {
    encoded = readFileSync(getFabricAuditAnchorPath(directory), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('FABRIC_AUDIT_ANCHOR_UNAVAILABLE')
  }
  try {
    const parsed = JSON.parse(encoded) as Partial<StoredAnchor>
    if (parsed.version !== 1 || !isAnchorState(parsed.committed, parsed.pending)
      || typeof parsed.mac !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.mac)) {
      throw new Error('invalid')
    }
    const committed = parsed.committed as FabricAuditCheckpoint
    const pending = parsed.pending as FabricAuditAnchorState['pending']
    const expected = anchorMac(key, { version: 1, committed, pending })
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parsed.mac, 'hex'))) throw new Error('invalid')
    return { committed, pending }
  } catch {
    throw new Error('FABRIC_AUDIT_ANCHOR_INVALID')
  }
}

export function writeFabricAuditAnchor(
  directory: string,
  key: Buffer,
  state: FabricAuditAnchorState,
): void {
  if (!isAnchorState(state.committed, state.pending)) throw new Error('FABRIC_AUDIT_ANCHOR_INVALID')
  mkdirSync(directory, { recursive: true })
  const unsigned = { version: 1 as const, committed: state.committed, pending: state.pending }
  const stored: StoredAnchor = { ...unsigned, mac: anchorMac(key, unsigned) }
  const target = getFabricAuditAnchorPath(directory)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, canonicalStringify(stored), 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, target)
    if (process.platform !== 'win32') {
      const directoryDescriptor = openSync(directory, 'r')
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    }
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { unlinkSync(temporary) } catch { /* best effort */ }
    throw new Error('FABRIC_AUDIT_ANCHOR_UNAVAILABLE')
  }
}

export function compareAndSwapFabricAuditAnchor(
  directory: string,
  key: Buffer,
  expected: FabricAuditAnchorState | null,
  next: FabricAuditAnchorState,
): boolean {
  const current = readFabricAuditAnchor(directory, key)
  if (!sameState(current, expected)) return false
  writeFabricAuditAnchor(directory, key, next)
  return true
}

function anchorMac(key: Buffer, value: Omit<StoredAnchor, 'mac'>): string {
  return createHmac('sha256', key).update(canonicalStringify(value), 'utf8').digest('hex')
}

function isCheckpoint(value: unknown): value is FabricAuditCheckpoint {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<FabricAuditCheckpoint>
  return Number.isSafeInteger(item.sequence) && (item.sequence ?? -1) >= 0
    && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash)
}

function isPending(value: unknown): value is FabricAuditAnchorState['pending'] {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const item = value as { previous?: unknown; next?: unknown }
  return isCheckpoint(item.previous) && isCheckpoint(item.next)
}

function isAnchorState(committed: unknown, pending: unknown): committed is FabricAuditCheckpoint {
  if (!isCheckpoint(committed) || !isPending(pending)) return false
  return pending === null || (pending.previous.sequence === committed.sequence
    && pending.previous.hash === committed.hash
    && pending.next.sequence >= pending.previous.sequence)
}

function sameState(left: FabricAuditAnchorState | null, right: FabricAuditAnchorState | null): boolean {
  if (left === null || right === null) return left === right
  return canonicalStringify(left) === canonicalStringify(right)
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
