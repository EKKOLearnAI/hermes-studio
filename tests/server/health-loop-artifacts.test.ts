import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('health artifact vault', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-health-artifacts-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  const png = () => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('synthetic-image'),
  ])

  const allowAccess = () => ({
    secureDirectory: async (_path: string) => undefined,
    secureFile: async (_path: string) => undefined,
  })

  it('stores health artifacts by their full content hash without trusting the filename', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const vault = createHealthArtifactVault({ accessController: allowAccess() })
    const content = png()
    const digest = createHash('sha256').update(content).digest('hex')

    const artifact = await vault.store({
      content,
      declaredMediaType: 'image/png',
      originalFilename: '..\\..\\secret.txt:stream',
      source: 'health-capture',
      sourceId: 'posture-front-1',
      metadata: { capture: 'front' },
    })

    expect(artifact).toMatchObject({
      id: `artifact-${digest}`,
      contentHash: digest,
      mediaType: 'image/png',
      sizeBytes: content.length,
      sensitivity: 'health',
      relativePath: `${digest.slice(0, 2)}/${digest}`,
    })
    expect(artifact).not.toHaveProperty('absolutePath')
    expect(artifact.relativePath).not.toContain('secret')
    expect(readFileSync(join(hermesHome, 'personal', 'artifacts', artifact.relativePath))).toEqual(content)
  })

  it('rejects empty, oversized, unsupported, and magic-mismatched input with sanitized errors', async () => {
    const { HealthArtifactVaultError, createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const vault = createHealthArtifactVault({ maxTotalBytes: 32, mediaTypeLimits: { 'image/png': 24 }, accessController: allowAccess() })
    const valid = { source: 'health-capture', sourceId: 'capture-1' }

    await expect(vault.store({ ...valid, content: Buffer.alloc(0), declaredMediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_EMPTY' })
    await expect(vault.store({ ...valid, content: Buffer.alloc(33, 1), declaredMediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_TOO_LARGE' })
    await expect(vault.store({ ...valid, content: Buffer.from('hello'), declaredMediaType: 'text/plain' }))
      .rejects.toBeInstanceOf(HealthArtifactVaultError)
    await expect(vault.store({ ...valid, content: Buffer.from('%PDF-1.7'), declaredMediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_MEDIA_MISMATCH' })

    for (const error of await Promise.all([
      vault.store({ ...valid, content: Buffer.from('hello'), declaredMediaType: 'text/plain' }).catch(value => value),
      vault.store({ ...valid, content: Buffer.from('%PDF-1.7'), declaredMediaType: 'image/png' }).catch(value => value),
    ])) {
      expect(error.message).not.toContain(hermesHome)
      expect(error).not.toHaveProperty('path')
    }
  })

  it('deduplicates concurrent identical writes and removes exclusive temp files', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const vault = createHealthArtifactVault({ accessController: allowAccess() })
    const request = {
      content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'capture-concurrent', metadata: {},
    }

    const artifacts = await Promise.all(Array.from({ length: 12 }, () => vault.store(request)))
    expect(new Set(artifacts.map(item => item.id))).toHaveLength(1)
    const root = join(hermesHome, 'personal', 'artifacts')
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => entry.name)
    expect(files).toEqual([artifacts[0].contentHash])
    expect(files.some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('revalidates path containment, regular-file status, size, MIME, and hash on every read', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const vault = createHealthArtifactVault({ accessController: allowAccess() })
    const artifact = await vault.store({
      content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'capture-read', metadata: {},
    })
    const path = join(hermesHome, 'personal', 'artifacts', artifact.relativePath)
    writeFileSync(path, Buffer.concat([png(), Buffer.from('tampered')]))
    await expect(vault.read(artifact.id)).rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_INTEGRITY_FAILED' })

    rmSync(path)
    symlinkSync(join(hermesHome, 'personal'), path, 'junction')
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    await expect(vault.read(artifact.id)).rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_UNSAFE_PATH' })
  })

  it('fails closed when the vault root is a junction and never writes outside it', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const outside = mkdtempSync(join(tmpdir(), 'hwui-health-artifacts-outside-'))
    const root = join(hermesHome, 'personal', 'artifacts')
    try {
      mkdirSync(join(hermesHome, 'personal'))
      symlinkSync(outside, root, 'junction')
      const vault = createHealthArtifactVault({ accessController: allowAccess() })
      await expect(vault.store({
        content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'unsafe-root', metadata: {},
      })).rejects.toMatchObject({ code: 'HEALTH_ARTIFACT_UNSAFE_PATH' })
      expect(existsSync(join(outside, createHash('sha256').update(png()).digest('hex')))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails closed on registry metadata conflicts without exposing filesystem details', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const vault = createHealthArtifactVault({ accessController: allowAccess() })
    const base = { content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'capture-conflict' }
    await vault.store({ ...base, metadata: { view: 'front' } })
    const error = await vault.store({ ...base, metadata: { view: 'back' } }).catch(value => value)
    expect(error).toMatchObject({ code: 'HEALTH_ARTIFACT_REGISTRY_CONFLICT' })
    expect(error.message).not.toContain(hermesHome)
  })

  it('exports the vault and consent broker from the public health-loop entry without initialization side effects', async () => {
    const before = existsSync(join(hermesHome, 'personal'))
    const entry = await import('../../packages/server/src/services/hermes/health-loop')
    expect(entry.createHealthArtifactVault).toBeTypeOf('function')
    expect(entry.createHealthConsentBroker).toBeTypeOf('function')
    expect(existsSync(join(hermesHome, 'personal'))).toBe(before)
  })

  it('secures root, shard, temp, and final paths and fails closed with temp cleanup on access-control failure', async () => {
    const { createHealthArtifactVault } = await import('../../packages/server/src/services/hermes/health-loop/artifacts')
    const directories: string[] = []
    const files: string[] = []
    const accessController = {
      secureDirectory: async (path: string) => { directories.push(path) },
      secureFile: async (path: string) => { files.push(path) },
    }
    const stored = await createHealthArtifactVault({ accessController }).store({
      content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'acl-success', metadata: {},
    })
    expect(directories.some(path => path.endsWith(join('personal', 'artifacts')))).toBe(true)
    expect(directories.some(path => path.endsWith(join('artifacts', stored.contentHash.slice(0, 2))))).toBe(true)
    expect(files.some(path => path.includes('.tmp-'))).toBe(true)
    expect(files.some(path => path.endsWith(stored.contentHash))).toBe(true)

    const failHome = mkdtempSync(join(tmpdir(), 'hwui-health-artifacts-acl-fail-'))
    process.env.HERMES_HOME = failHome
    try {
      const failedVault = createHealthArtifactVault({
        accessController: {
          secureDirectory: async () => undefined,
          secureFile: async () => { throw new Error(`ACL detail ${failHome}`) },
        },
      })
      const error = await failedVault.store({
        content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'acl-failure', metadata: {},
      }).catch(value => value)
      expect(error).toMatchObject({ code: 'HEALTH_ARTIFACT_ACCESS_DENIED' })
      expect(error.message).not.toContain(failHome)
      const root = join(failHome, 'personal', 'artifacts')
      const remaining = existsSync(root)
        ? readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)
        : []
      expect(remaining).toEqual([])
    } finally {
      process.env.HERMES_HOME = hermesHome
      rmSync(failHome, { recursive: true, force: true })
    }

    const verifyFailHome = mkdtempSync(join(tmpdir(), 'hwui-health-artifacts-acl-verify-fail-'))
    process.env.HERMES_HOME = verifyFailHome
    try {
      const verifyFailVault = createHealthArtifactVault({
        accessController: {
          secureDirectory: async () => { throw new Error(`ACL verification detail ${verifyFailHome}`) },
          secureFile: async () => undefined,
        },
      })
      const error = await verifyFailVault.store({
        content: png(), declaredMediaType: 'image/png', source: 'health-capture', sourceId: 'acl-verify-failure', metadata: {},
      }).catch(value => value)
      expect(error).toMatchObject({ code: 'HEALTH_ARTIFACT_ACCESS_DENIED' })
      expect(error.message).not.toContain(verifyFailHome)
    } finally {
      process.env.HERMES_HOME = hermesHome
      rmSync(verifyFailHome, { recursive: true, force: true })
    }
  })
})
