import { randomUUID } from 'crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))

export function getFabricAuditWriterLockPath(directory: string): string {
  return join(directory, '.action-fabric-audit-writer.lock')
}

export function withFabricAuditWriterLock<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true })
  const path = getFabricAuditWriterLockPath(directory)
  const token = randomUUID()
  const encoded = JSON.stringify({ pid: process.pid, token })
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      const descriptor = openSync(path, 'wx', 0o600)
      try { writeFileSync(descriptor, encoded, 'utf8') } finally { closeSync(descriptor) }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('FABRIC_AUDIT_WRITER_LOCK_UNAVAILABLE')
      const existing = readLock(path)
      if (existing === null) throw new Error('FABRIC_AUDIT_WRITER_LOCK_INVALID')
      if (!isProcessAlive(existing.pid)) {
        const current = readFileSync(path, 'utf8')
        if (current === existing.encoded) {
          try { unlinkSync(path) } catch { /* another recovery attempt won */ }
        }
        continue
      }
      if (Date.now() >= deadline) throw new Error('FABRIC_AUDIT_WRITER_BUSY')
      Atomics.wait(WAIT_BUFFER, 0, 0, 25)
    }
  }
  try {
    return operation()
  } finally {
    let current: string
    try { current = readFileSync(path, 'utf8') } catch { throw new Error('FABRIC_AUDIT_WRITER_LOCK_LOST') }
    if (current !== encoded) throw new Error('FABRIC_AUDIT_WRITER_LOCK_LOST')
    try { unlinkSync(path) } catch { throw new Error('FABRIC_AUDIT_WRITER_LOCK_UNAVAILABLE') }
  }
}

function readLock(path: string): { pid: number; token: string; encoded: string } | null {
  try {
    const encoded = readFileSync(path, 'utf8')
    const parsed = JSON.parse(encoded) as { pid?: unknown; token?: unknown }
    return Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
      && typeof parsed.token === 'string' && /^[a-f0-9-]{36}$/.test(parsed.token)
      ? { pid: parsed.pid as number, token: parsed.token, encoded }
      : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
