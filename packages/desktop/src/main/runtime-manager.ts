import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { basename, dirname, join, relative } from 'node:path'
import { app } from 'electron'
import {
  desktopRuntimeDir,
  desktopRuntimeVersion,
  legacyDesktopRuntimeDir,
  runtimePlatformKey,
  targetDesktopRuntimeDir,
  webUiHome,
  webuiDir,
} from './paths'
import {
  hermesAgentVersionFromRuntimeTag,
  runtimeManifestMatchesHermesAgentVersion,
} from './runtime-version'
import { extractTarGzipArchive } from './runtime-archive'
import { t } from './desktop-i18n'

const DEFAULT_RUNTIME_BASE_URL = 'https://download.ekkolearnai.com'
const DEFAULT_RUNTIME_GITHUB_REPO = 'EKKOLearnAI/hermes-web-ui'
const RUNTIME_MANIFEST_NAME = 'runtime-manifest.json'
const PACKAGED_RUNTIME_RELEASE_NAME = 'runtime-release.json'
const ACTIVE_RUNTIME_VERSION_NAME = 'active-version.json'

export type RuntimeDownloadSource = 'cf' | 'github'

type RuntimeManifest = {
  schema: number
  platform: string
  hermesAgentVersion?: string
  asset?: {
    name: string
    url?: string
    sha256?: string
    size?: number
  }
}

type RuntimeDescriptor = {
  name: string
  url: string
  sha256?: string
  hermesAgentVersion?: string
}

type PackagedRuntimeRelease = {
  tag?: string
  hermesAgentVersion?: string
}

export type RuntimeProgress = {
  stage: 'migrate' | 'resolve' | 'download' | 'verify' | 'extract' | 'ready'
  message: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

type RuntimeProgressHandler = (progress: RuntimeProgress) => void

export type RuntimeMigrationResult = {
  status: 'not-needed' | 'migrated' | 'failed'
  from?: string
  to?: string
  error?: string
}

function runtimeDownloadSource(source?: RuntimeDownloadSource): RuntimeDownloadSource | null {
  if (source) return source
  const value = process.env.HERMES_DESKTOP_RUNTIME_SOURCE?.trim().toLowerCase()
  if (value === 'github' || value === 'cf') return value
  return null
}

function requiredRuntimeFiles(root: string): string[] {
  const pythonBin = process.platform === 'win32'
    ? join(root, 'python', 'python.exe')
    : join(root, 'python', 'bin', 'python3')
  const hermesBin = process.platform === 'win32'
    ? join(root, 'python', 'Scripts', 'hermes.exe')
    : join(root, 'python', 'bin', 'hermes')
  const nodeBin = process.platform === 'win32'
    ? join(root, 'node', 'node.exe')
    : join(root, 'node', 'bin', 'node')
  const files = [pythonBin, hermesBin, nodeBin, join(root, RUNTIME_MANIFEST_NAME)]
  if (process.platform === 'win32') files.push(join(root, 'git', 'cmd', 'git.exe'))
  return files
}

function missingRuntimeFiles(root: string): string[] {
  return requiredRuntimeFiles(root).filter(file => !existsSync(file))
}

function runtimeReady(): boolean {
  return rootRuntimeReady(desktopRuntimeDir())
}

function rootRuntimeReady(root: string): boolean {
  const gitPath = process.platform === 'win32' ? join(root, 'git', 'cmd', 'git.exe') : null
  return existsSync(process.platform === 'win32' ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3'))
    && existsSync(process.platform === 'win32' ? join(root, 'python', 'Scripts', 'hermes.exe') : join(root, 'python', 'bin', 'hermes'))
    && existsSync(process.platform === 'win32' ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node'))
    && (!gitPath || existsSync(gitPath))
}

export function isDesktopRuntimeReady(): boolean {
  return runtimeReady()
}

export function migrateLegacyDesktopRuntime(onProgress?: RuntimeProgressHandler): RuntimeMigrationResult {
  if (process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()) return { status: 'not-needed' }
  if (runtimeReady()) return { status: 'not-needed' }

  const from = legacyDesktopRuntimeDir()
  const to = targetDesktopRuntimeDir()
  if (from === to || !existsSync(from)) return { status: 'not-needed' }

  onProgress?.({ stage: 'migrate', message: t('runtime.migrating') })

  const missing = missingRuntimeFiles(from)
  if (missing.length > 0) {
    const error = `Legacy runtime is missing required files: ${missing.map(file => relative(from, file)).join(', ')}`
    console.warn(`[runtime] ${error}`)
    onProgress?.({ stage: 'migrate', message: t('runtime.migrationFailed') })
    return { status: 'failed', from, to, error }
  }

  try {
    mkdirSync(dirname(to), { recursive: true })
    rmSync(to, { recursive: true, force: true })
    renameSync(from, to)
    onProgress?.({ stage: 'migrate', message: t('runtime.migrated') })
    console.log(`[runtime] migrated Hermes runtime from ${from} to ${to}`)
    return { status: 'migrated', from, to }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[runtime] failed to migrate Hermes runtime from ${from} to ${to}: ${error}`)
    onProgress?.({ stage: 'migrate', message: t('runtime.migrationFailed') })
    return { status: 'failed', from, to, error }
  }
}

function releaseTagCandidates(): string[] {
  const override = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG?.trim()
  if (override) return [override]

  const version = app.getVersion()
  const candidates = [packagedRuntimeReleaseTag(), version, `v${version}`, 'latest']
  return Array.from(new Set(candidates.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)))
}

function packagedRuntimeReleaseMetadata(): PackagedRuntimeRelease | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'build', PACKAGED_RUNTIME_RELEASE_NAME)]
    : [join(app.getAppPath(), 'build', PACKAGED_RUNTIME_RELEASE_NAME)]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as { tag?: unknown; hermesAgentVersion?: unknown }
      return {
        tag: typeof metadata.tag === 'string' && metadata.tag.trim() ? metadata.tag.trim() : undefined,
        hermesAgentVersion: typeof metadata.hermesAgentVersion === 'string' && metadata.hermesAgentVersion.trim()
          ? metadata.hermesAgentVersion.trim()
          : undefined,
      }
    } catch {}
  }

  return null
}

function packagedRuntimeReleaseTag(): string | null {
  const metadata = packagedRuntimeReleaseMetadata()
  if (metadata?.tag) return metadata.tag
  return null
}

export function cachedRuntimeNeedsPackagedReleaseUpdate(): boolean {
  const metadata = packagedRuntimeReleaseMetadata()
  const expectedVersion = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
    ? hermesAgentVersionFromRuntimeTag(process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG)
    : metadata?.hermesAgentVersion || hermesAgentVersionFromRuntimeTag(metadata?.tag)
  if (!expectedVersion) return false
  const match = runtimeManifestMatchesHermesAgentVersion(readCachedRuntimeManifest(desktopRuntimeDir()), expectedVersion)
  return match === false
}

function runtimeAssetUrl(assetName: string, tag: string, source: RuntimeDownloadSource): string {
  if (source === 'github') {
    const repo = process.env.HERMES_DESKTOP_RUNTIME_REPO?.trim() || DEFAULT_RUNTIME_GITHUB_REPO
    if (tag === 'latest') {
      return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(assetName)}`
    }
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
  }

  const template = process.env.HERMES_DESKTOP_RUNTIME_BASE_URL?.trim() || DEFAULT_RUNTIME_BASE_URL
  if (template.includes('{asset}') || template.includes('{tag}')) {
    return template
      .replace(/\{asset\}/g, encodeURIComponent(assetName))
      .replace(/\{tag\}/g, encodeURIComponent(tag))
  }
  return `${template.replace(/\/$/, '')}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

async function fetchJson<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`GET ${url} returned ${response.status}`)
    }
    return await response.json() as T
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`GET ${url}`)) throw err
    throw new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function resolveRuntimeDescriptor(source?: RuntimeDownloadSource): Promise<RuntimeDescriptor> {
  const directUrl = process.env.HERMES_DESKTOP_RUNTIME_URL?.trim()
  if (directUrl) {
    return { name: basename(new URL(directUrl).pathname) || 'hermes-runtime.tar.gz', url: directUrl }
  }

  const downloadSource = runtimeDownloadSource(source)
  const platformManifestName = `hermes-runtime-${runtimePlatformKey()}.json`
  const manifestOverride = process.env.HERMES_DESKTOP_RUNTIME_MANIFEST_URL?.trim()
  if (!downloadSource && !manifestOverride) {
    throw new Error('Hermes runtime download source is not selected')
  }

  const candidates = manifestOverride
    ? [{ tag: '', url: manifestOverride }]
    : releaseTagCandidates().map(tag => ({ tag, url: runtimeAssetUrl(platformManifestName, tag, downloadSource!) }))

  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      console.log(`[runtime] resolving Hermes runtime from ${downloadSource || 'custom'}: ${candidate.url}`)
      const manifest = await fetchJson<RuntimeManifest>(candidate.url)
      if (!manifest.asset?.name) {
        throw new Error(`runtime manifest is missing asset.name: ${candidate.url}`)
      }
      if (!manifest.asset.url && !downloadSource) {
        throw new Error(`runtime manifest is missing asset.url and no download source was selected: ${candidate.url}`)
      }
      return {
        name: manifest.asset.name,
        url: manifest.asset.url || runtimeAssetUrl(manifest.asset.name, candidate.tag, downloadSource!),
        sha256: manifest.asset.sha256,
        hermesAgentVersion: manifest.hermesAgentVersion,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError || new Error('Unable to resolve Hermes desktop runtime package')
}

function readCachedRuntimeManifest(root: string): RuntimeManifest | null {
  const file = join(root, RUNTIME_MANIFEST_NAME)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RuntimeManifest
  } catch {
    return null
  }
}

function webUiVersion(): string {
  const packageJson = join(webuiDir(), 'package.json')
  try {
    const metadata = JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: unknown }
    if (typeof metadata.version === 'string' && metadata.version.trim()) return metadata.version.trim()
  } catch {}
  return app.getVersion()
}

export function writeActiveRuntimeVersion(runtimeRoot = desktopRuntimeDir()): void {
  const manifest = readCachedRuntimeManifest(runtimeRoot)
  const hermesRuntimeVersion = manifest?.hermesAgentVersion || desktopRuntimeVersion()
  const activeVersionPath = join(webUiHome(), 'desktop-runtime', ACTIVE_RUNTIME_VERSION_NAME)
  mkdirSync(dirname(activeVersionPath), { recursive: true })
  writeFileSync(activeVersionPath, JSON.stringify({
    schema: 1,
    hermesRuntimeVersion,
    webUiVersion: webUiVersion(),
    runtimeDirectory: runtimeRoot,
    webUiDirectory: webuiDir(),
    platform: runtimePlatformKey(),
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n')
}

function cachedRuntimeMatches(root: string, descriptor: RuntimeDescriptor): boolean {
  if (!rootRuntimeReady(root)) return false
  const manifest = readCachedRuntimeManifest(root)
  if (!manifest?.asset?.name) return true
  return manifest.asset.name === descriptor.name
}

function downloadFile(
  url: string,
  target: string,
  onProgress?: RuntimeProgressHandler,
  redirects = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
    const req = getter(parsed, response => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume()
        downloadFile(new URL(location, url).toString(), target, onProgress, redirects - 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`GET ${url} returned ${status}`))
        return
      }

      const totalBytes = Number(response.headers['content-length']) || undefined
      let receivedBytes = 0
      response.on('data', chunk => {
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        onProgress?.({
          stage: 'download',
          message: t('runtime.downloading'),
          percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
          receivedBytes,
          totalBytes,
        })
      })

      const file = createWriteStream(target)
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', err => {
      reject(new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`))
    })
  })
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function extractRuntimeArchive(archive: string, targetRoot: string): Promise<void> {
  const parent = dirname(targetRoot)
  const tempRoot = join(parent, `.runtime-${process.pid}-${Date.now()}`)
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    await extractTarGzipArchive(archive, tempRoot)
    const missing = missingRuntimeFiles(tempRoot)
    if (missing.length > 0) {
      throw new Error(`Runtime archive is missing required files: ${missing.map(file => relative(tempRoot, file)).join(', ')}`)
    }
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
    renameSync(tempRoot, targetRoot)
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw err
  }
}

export async function ensureDesktopRuntime(
  onProgress?: RuntimeProgressHandler,
  source?: RuntimeDownloadSource,
  skipMigration = false,
): Promise<void> {
  if (!skipMigration) migrateLegacyDesktopRuntime(onProgress)
  const runtimeRoot = targetDesktopRuntimeDir()
  mkdirSync(runtimeRoot, { recursive: true })

  let descriptor: RuntimeDescriptor
  try {
    onProgress?.({ stage: 'resolve', message: t('runtime.checking') })
    descriptor = await resolveRuntimeDescriptor(source)
  } catch (err) {
    if (runtimeReady() && !process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE) {
      console.warn(`[runtime] using cached Hermes runtime because update check failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    throw err
  }

  if (cachedRuntimeMatches(runtimeRoot, descriptor) && !process.env.HERMES_DESKTOP_RUNTIME_FORCE_UPDATE) return

  const archive = join(dirname(runtimeRoot), `${descriptor.name}.download`)
  console.log(`[runtime] downloading Hermes runtime ${descriptor.name}`)
  onProgress?.({ stage: 'download', message: t('runtime.downloadingPackage', { name: descriptor.name }) })
  let archiveSize = 0
  try {
    await downloadFile(descriptor.url, archive, onProgress)
    archiveSize = statSync(archive).size
    if (descriptor.sha256) {
      onProgress?.({ stage: 'verify', message: t('runtime.verifying') })
      const actual = await sha256File(archive)
      if (actual !== descriptor.sha256) {
        throw new Error(`Runtime checksum mismatch for ${descriptor.name}`)
      }
    }

    onProgress?.({ stage: 'extract', message: t('runtime.extracting') })
    await extractRuntimeArchive(archive, runtimeRoot)
  } finally {
    rmSync(archive, { force: true })
  }

  const manifestPath = join(runtimeRoot, RUNTIME_MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      schema: 1,
      platform: runtimePlatformKey(),
      hermesAgentVersion: descriptor.hermesAgentVersion,
      asset: {
        name: descriptor.name,
        sha256: descriptor.sha256,
        size: archiveSize,
      },
    }, null, 2))
  }
  onProgress?.({ stage: 'ready', message: t('runtime.ready') })
  writeActiveRuntimeVersion(runtimeRoot)
  console.log(`[runtime] Hermes runtime ready at ${runtimeRoot}`)
}
