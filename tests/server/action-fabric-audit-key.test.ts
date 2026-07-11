import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { FabricAuditKeyProvider } from '../../packages/server/src/services/hermes/action-fabric/audit-key'

describe('action fabric audit key provider', () => {
  let directory = ''
  const originalManaged = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY

  afterEach(() => {
    if (originalManaged === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalManaged
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('uses a managed key before platform storage', () => {
    directory = mkdtempSync(join(tmpdir(), 'fabric-audit-key-'))
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'managed-audit-key-at-least-32-bytes'
    const provider = new FabricAuditKeyProvider({
      directory, platform: 'win32', runDpapi: () => { throw new Error('must not run') },
    })
    expect(provider.getKey()).toEqual(Buffer.from(process.env.HERMES_ACTION_FABRIC_AUDIT_KEY))
  })

  it('stores only a DPAPI CurrentUser blob on Windows and decrypts it after restart', () => {
    directory = mkdtempSync(join(tmpdir(), 'fabric-audit-key-'))
    delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    const calls: string[] = []
    const runDpapi = (operation: 'protect' | 'unprotect', input: Buffer): Buffer => {
      calls.push(operation)
      return operation === 'protect' ? Buffer.concat([Buffer.from('protected:'), input]) : input.subarray(10)
    }
    const first = new FabricAuditKeyProvider({ directory, platform: 'win32', runDpapi })
    const key = first.getKey()
    const blobPath = join(directory, '.action-fabric-audit-key.dpapi')
    const stored = readFileSync(blobPath, 'utf8')
    expect(stored).toMatch(/^dpapi-v1:/)
    expect(stored).not.toContain(key.toString('hex'))
    expect(existsSync(join(directory, '.action-fabric-audit-key'))).toBe(false)
    expect(first.getKey()).toBe(key)

    const restarted = new FabricAuditKeyProvider({ directory, platform: 'win32', runDpapi })
    expect(restarted.getKey()).toEqual(key)
    expect(calls).toEqual(['protect', 'unprotect'])
  })

  it('fails closed without writing a raw Windows key when DPAPI is unavailable', () => {
    directory = mkdtempSync(join(tmpdir(), 'fabric-audit-key-'))
    delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    const provider = new FabricAuditKeyProvider({
      directory, platform: 'win32', runDpapi: () => { throw new Error('provider details with secret') },
    })
    expect(() => provider.getKey()).toThrow('FABRIC_AUDIT_KEY_UNAVAILABLE')
    expect(existsSync(join(directory, '.action-fabric-audit-key'))).toBe(false)
  })

  it('rejects unsafe POSIX key permissions', () => {
    directory = mkdtempSync(join(tmpdir(), 'fabric-audit-key-'))
    delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    const path = join(directory, '.action-fabric-audit-key')
    writeFileSync(path, 'a'.repeat(64))
    chmodSync(path, 0o644)
    const provider = new FabricAuditKeyProvider({ directory, platform: 'linux' })
    expect(() => provider.getKey()).toThrow('FABRIC_AUDIT_KEY_PERMISSIONS')
  })
})
