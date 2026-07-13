import { createHash, randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import {
  chmod, link, lstat, mkdir, open, realpath, unlink,
} from 'fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { getHermesBaseDir } from '../hermes-profile'
import {
  getTwinArtifact, TwinArtifact, TwinImmutableRecordConflictError, upsertTwinArtifact,
} from '../personal-twin'

const SHA256 = /^[0-9a-f]{64}$/
const ARTIFACT_ID = /^artifact-([0-9a-f]{64})$/
const DEFAULT_TOTAL_LIMIT = 250 * 1024 * 1024
const DEFAULT_MEDIA_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'application/pdf': 50 * 1024 * 1024,
  'image/jpeg': 25 * 1024 * 1024,
  'image/png': 25 * 1024 * 1024,
  'text/csv': 10 * 1024 * 1024,
  'application/json': 10 * 1024 * 1024,
  'video/mp4': 250 * 1024 * 1024,
})

export type HealthArtifactVaultErrorCode =
  | 'HEALTH_ARTIFACT_EMPTY'
  | 'HEALTH_ARTIFACT_TOO_LARGE'
  | 'HEALTH_ARTIFACT_MEDIA_UNSUPPORTED'
  | 'HEALTH_ARTIFACT_MEDIA_MISMATCH'
  | 'HEALTH_ARTIFACT_INVALID_INPUT'
  | 'HEALTH_ARTIFACT_UNSAFE_PATH'
  | 'HEALTH_ARTIFACT_WRITE_FAILED'
  | 'HEALTH_ARTIFACT_NOT_FOUND'
  | 'HEALTH_ARTIFACT_INTEGRITY_FAILED'
  | 'HEALTH_ARTIFACT_REGISTRY_CONFLICT'
  | 'HEALTH_ARTIFACT_REGISTRY_FAILED'

export class HealthArtifactVaultError extends Error {
  readonly code: HealthArtifactVaultErrorCode

  constructor(code: HealthArtifactVaultErrorCode) {
    super(code)
    this.name = 'HealthArtifactVaultError'
    this.code = code
  }
}

export interface StoreHealthArtifactInput {
  content: Uint8Array
  declaredMediaType: string
  originalFilename?: string
  source: string
  sourceId: string
  metadata?: Record<string, unknown>
}

export interface ReadHealthArtifactResult {
  artifact: TwinArtifact
  content: Buffer
}

export interface HealthArtifactVaultOptions {
  maxTotalBytes?: number
  mediaTypeLimits?: Readonly<Record<string, number>>
}

export interface HealthArtifactVault {
  store(input: StoreHealthArtifactInput): Promise<TwinArtifact>
  read(artifactId: string): Promise<ReadHealthArtifactResult>
}

function safePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 1024 * 1024 * 1024) {
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INVALID_INPUT')
  }
  return value
}

function normalizeLimits(options: HealthArtifactVaultOptions): { total: number; media: Readonly<Record<string, number>> } {
  const total = safePositiveLimit(options.maxTotalBytes, DEFAULT_TOTAL_LIMIT)
  if (options.mediaTypeLimits === undefined) return { total, media: DEFAULT_MEDIA_LIMITS }
  if (!options.mediaTypeLimits || typeof options.mediaTypeLimits !== 'object' || Array.isArray(options.mediaTypeLimits)) {
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INVALID_INPUT')
  }
  const media: Record<string, number> = { ...DEFAULT_MEDIA_LIMITS }
  for (const [key, value] of Object.entries(options.mediaTypeLimits)) {
    if (!(key in DEFAULT_MEDIA_LIMITS)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INVALID_INPUT')
    media[key] = safePositiveLimit(value, DEFAULT_MEDIA_LIMITS[key])
  }
  return { total, media: Object.freeze(media) }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertLocalPath(path: string): void {
  const normalized = path.replace(/\//g, '\\')
  if (normalized.startsWith('\\\\') || normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) {
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
  }
  const remainder = /^[a-zA-Z]:\\/.test(normalized) ? normalized.slice(2) : normalized
  if (remainder.includes(':')) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  const stat = await optionalLstat(path)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
  }
}

async function createDirectoryIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function prepareVaultRoot(base: string, root: string): Promise<string> {
  try {
    assertLocalPath(base)
    assertLocalPath(root)
    if (!isPathInside(base, root)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
    await assertSafeDirectory(base)
    const personal = resolve(base, 'personal')
    const personalStat = await optionalLstat(personal)
    if (!personalStat) await createDirectoryIfMissing(personal)
    await assertSafeDirectory(personal)
    const rootStat = await optionalLstat(root)
    if (!rootStat) await createDirectoryIfMissing(root)
    await assertSafeDirectory(root)
    const [baseReal, rootReal] = await Promise.all([realpath(base), realpath(root)])
    if (!isPathInside(baseReal, rootReal)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
    await chmod(root, 0o700).catch(() => undefined)
    return rootReal
  } catch (error) {
    if (error instanceof HealthArtifactVaultError) throw error
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
  }
}

function decodeUtf8(content: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }
}

function sniffMediaType(content: Buffer): string | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg'
  if (content.length >= 5 && content.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (content.length >= 12 && content.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  const text = decodeUtf8(content)
  if (text === null || text.includes('\0')) return null
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'application/json'
    } catch {
      return null
    }
  }
  if (/[,;\t]/.test(text) && /\r?\n/.test(text)) return 'text/csv'
  return null
}

function validateMedia(content: Buffer, declaredMediaType: unknown, limits: { total: number; media: Readonly<Record<string, number>> }): string {
  if (content.length === 0) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_EMPTY')
  if (content.length > limits.total) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_TOO_LARGE')
  if (typeof declaredMediaType !== 'string' || !(declaredMediaType in limits.media)) {
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_MEDIA_UNSUPPORTED')
  }
  if (content.length > limits.media[declaredMediaType]) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_TOO_LARGE')
  if (sniffMediaType(content) !== declaredMediaType) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_MEDIA_MISMATCH')
  return declaredMediaType
}

async function verifyStoredFile(path: string, expectedHash: string, expectedSize: number, expectedMediaType: string, rootReal: string): Promise<Buffer> {
  try {
    const parent = dirname(path)
    await assertSafeDirectory(parent)
    const pathStat = await lstat(path)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
    const resolved = await realpath(path)
    if (!isPathInside(rootReal, resolved) || basename(resolved) !== expectedHash) {
      throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await open(path, flags)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== expectedSize) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INTEGRITY_FAILED')
      const content = await handle.readFile()
      const after = await handle.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || createHash('sha256').update(content).digest('hex') !== expectedHash
        || sniffMediaType(content) !== expectedMediaType) {
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INTEGRITY_FAILED')
      }
      return content
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof HealthArtifactVaultError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HealthArtifactVaultError('HEALTH_ARTIFACT_NOT_FOUND')
    throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INTEGRITY_FAILED')
  }
}

export function createHealthArtifactVault(options: HealthArtifactVaultOptions = {}): HealthArtifactVault {
  const limits = normalizeLimits(options)
  const base = resolve(getHermesBaseDir())
  const root = resolve(base, 'personal', 'artifacts')

  return {
    async store(input): Promise<TwinArtifact> {
      if (!input || typeof input !== 'object' || !(input.content instanceof Uint8Array)) {
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INVALID_INPUT')
      }
      const content = Buffer.from(input.content)
      const mediaType = validateMedia(content, input.declaredMediaType, limits)
      const contentHash = createHash('sha256').update(content).digest('hex')
      const rootReal = await prepareVaultRoot(base, root)
      const shard = resolve(root, contentHash.slice(0, 2))
      try {
        const shardStat = await optionalLstat(shard)
        if (!shardStat) await createDirectoryIfMissing(shard)
        await assertSafeDirectory(shard)
        const shardReal = await realpath(shard)
        if (!isPathInside(rootReal, shardReal)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
      } catch (error) {
        if (error instanceof HealthArtifactVaultError) throw error
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
      }
      const finalPath = resolve(shard, contentHash)
      if (!isPathInside(root, finalPath)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
      const tempPath = resolve(shard, `.${contentHash}.tmp-${randomBytes(16).toString('hex')}`)
      let createdFinal = false
      try {
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
        const handle = await open(tempPath, flags, 0o600)
        try {
          await handle.writeFile(content)
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await link(tempPath, finalPath)
          createdFinal = true
          await chmod(finalPath, 0o600).catch(() => undefined)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } catch (error) {
        if (error instanceof HealthArtifactVaultError) throw error
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_WRITE_FAILED')
      } finally {
        await unlink(tempPath).catch(() => undefined)
      }

      try {
        await verifyStoredFile(finalPath, contentHash, content.length, mediaType, rootReal)
      } catch (error) {
        if (createdFinal) await unlink(finalPath).catch(() => undefined)
        throw error
      }

      try {
        return upsertTwinArtifact({
          mediaType,
          contentHash,
          relativePath: `${contentHash.slice(0, 2)}/${contentHash}`,
          sizeBytes: content.length,
          sensitivity: 'health',
          metadata: input.metadata ?? {},
          source: input.source,
          sourceId: input.sourceId,
        })
      } catch (error) {
        if (error instanceof TwinImmutableRecordConflictError) {
          throw new HealthArtifactVaultError('HEALTH_ARTIFACT_REGISTRY_CONFLICT')
        }
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_REGISTRY_FAILED')
      }
    },

    async read(artifactId): Promise<ReadHealthArtifactResult> {
      const match = typeof artifactId === 'string' ? ARTIFACT_ID.exec(artifactId) : null
      if (!match || !SHA256.test(match[1])) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_NOT_FOUND')
      let artifact: TwinArtifact | null
      try {
        artifact = getTwinArtifact(match[1])
      } catch {
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_INTEGRITY_FAILED')
      }
      if (!artifact || artifact.id !== artifactId || artifact.sensitivity !== 'health') {
        throw new HealthArtifactVaultError('HEALTH_ARTIFACT_NOT_FOUND')
      }
      const expectedRelativePath = `${artifact.contentHash.slice(0, 2)}/${artifact.contentHash}`
      if (artifact.relativePath !== expectedRelativePath) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
      const rootReal = await prepareVaultRoot(base, root)
      const path = resolve(root, ...artifact.relativePath.split('/'))
      if (!isPathInside(root, path)) throw new HealthArtifactVaultError('HEALTH_ARTIFACT_UNSAFE_PATH')
      const content = await verifyStoredFile(path, artifact.contentHash, artifact.sizeBytes, artifact.mediaType, rootReal)
      return { artifact, content }
    },
  }
}
