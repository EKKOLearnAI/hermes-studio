import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { get as httpGet } from 'http'
import { get as httpsGet } from 'https'
import { basename, dirname, join, relative, resolve } from 'path'
import * as tar from 'tar'
import { config } from '../config'
import { getHermesWebUiVersion } from './system-info'

const ACTIVE_VERSION_FILE = 'active-version.json'
const DEFAULT_REMOTE_MANIFEST_URL = 'https://hermes-studio.ai/versions.json'
const DEFAULT_DOWNLOAD_BASE_URL = 'https://download.ekkolearnai.com'
const DEFAULT_GITHUB_REPO = 'EKKOLearnAI/hermes-studio'

export interface ActiveVersionManifest {
  schema: number
  hermesRuntimeVersion?: string
  webUiVersion?: string
  runtimeDirectory?: string
  webUiDirectory?: string
  platform?: string
  updatedAt?: string
}

export interface InstalledRuntimeVersion {
  version: string
  platform: string
  directory: string
  active: boolean
  manifestHermesRuntimeVersion?: string
}

export interface InstalledWebUiVersion {
  version: string
  directory: string
  active: boolean
}

export interface RemoteVersionManifest {
  schema?: number
  hermes?: string[]
  webui?: string[]
}

export type VersionDownloadKind = 'runtime' | 'webui'
export type VersionDownloadSource = 'cf' | 'github'
export type VersionDownloadJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type VersionDownloadStage = 'queued' | 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'completed' | 'failed'

export interface VersionDownloadJob {
  id: string
  kind: VersionDownloadKind
  source: VersionDownloadSource
  version: string
  status: VersionDownloadJobStatus
  stage: VersionDownloadStage
  message: string
  error: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  createdAt: string
  updatedAt: string
  result?: InstalledRuntimeVersion | InstalledWebUiVersion
}

export interface RuntimeVersionStatus {
  active: ActiveVersionManifest | null
  platform: string
  activeVersionPath: string
  remoteManifestUrl: string
  remoteError: string
  hermes: {
    activeVersion: string
    activeDirectory: string
    installed: InstalledRuntimeVersion[]
    remoteVersions: string[]
  }
  webui: {
    currentVersion: string
    activeVersion: string
    activeDirectory: string
    installed: InstalledWebUiVersion[]
    remoteVersions: string[]
  }
}

interface RuntimePackageManifest {
  hermesAgentVersion?: string
  asset?: {
    name?: string
    url?: string
    sha256?: string
    size?: number
  }
}

interface DownloadProgress {
  stage: VersionDownloadStage
  message: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

type DownloadProgressHandler = (progress: DownloadProgress) => void

function runtimePlatformKey(platformName = process.platform, archName = process.arch): string {
  const osLabel = platformName === 'win32' ? 'win' : platformName === 'darwin' ? 'mac' : platformName
  return `${osLabel}-${archName}`
}

function desktopRuntimeRoot(): string {
  return join(config.appHome, 'desktop-runtime')
}

function activeVersionPath(): string {
  return join(desktopRuntimeRoot(), ACTIVE_VERSION_FILE)
}

function downloadBaseUrl(): string {
  return (process.env.HERMES_WEB_UI_DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE_URL).trim().replace(/\/$/, '')
}

function downloadAssetUrl(assetName: string, tag: string, source: VersionDownloadSource): string {
  if (source === 'github') {
    const repo = process.env.HERMES_WEB_UI_DOWNLOAD_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
  }
  return `${downloadBaseUrl()}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

export function readActiveVersionManifest(): ActiveVersionManifest | null {
  return readJsonFile<ActiveVersionManifest>(activeVersionPath())
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function readRuntimeManifestVersion(runtimeDir: string): string | undefined {
  const manifest = readJsonFile<{ hermesAgentVersion?: unknown; asset?: { name?: unknown } }>(join(runtimeDir, 'runtime-manifest.json'))
  if (typeof manifest?.hermesAgentVersion === 'string' && manifest.hermesAgentVersion.trim()) {
    return manifest.hermesAgentVersion.trim()
  }
  const assetName = typeof manifest?.asset?.name === 'string' ? manifest.asset.name : ''
  const match = assetName.match(/hermes-agent-([^-]+)-/)
  return match?.[1]
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
  const files = [pythonBin, hermesBin, nodeBin, join(root, 'runtime-manifest.json')]
  if (process.platform === 'win32') files.push(join(root, 'git', 'cmd', 'git.exe'))
  return files
}

function missingRuntimeFiles(root: string): string[] {
  return requiredRuntimeFiles(root).filter(file => !existsSync(file))
}

export function listInstalledRuntimeVersions(active = readActiveVersionManifest()): InstalledRuntimeVersion[] {
  const root = join(desktopRuntimeRoot(), 'hermes')
  if (!existsSync(root)) return []

  const currentPlatform = runtimePlatformKey()
  const activeDir = active?.runtimeDirectory ? resolve(active.runtimeDirectory) : ''
  const installed: InstalledRuntimeVersion[] = []

  for (const versionEntry of readdirSync(root, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue
    const version = versionEntry.name
    const platformRoot = join(root, version)
    for (const platformEntry of readdirSync(platformRoot, { withFileTypes: true })) {
      if (!platformEntry.isDirectory()) continue
      const directory = join(platformRoot, platformEntry.name)
      installed.push({
        version,
        platform: platformEntry.name,
        directory,
        active: activeDir === resolve(directory),
        manifestHermesRuntimeVersion: readRuntimeManifestVersion(directory),
      })
    }
  }

  return installed.sort((left, right) => {
    if (left.platform === currentPlatform && right.platform !== currentPlatform) return -1
    if (right.platform === currentPlatform && left.platform !== currentPlatform) return 1
    return right.version.localeCompare(left.version, undefined, { numeric: true })
  })
}

export function listInstalledWebUiVersions(active = readActiveVersionManifest()): InstalledWebUiVersion[] {
  const root = join(config.appHome, 'webui')
  if (!existsSync(root)) return []

  const activeDir = active?.webUiDirectory ? resolve(active.webUiDirectory) : ''
  const installed: InstalledWebUiVersion[] = []

  for (const versionEntry of readdirSync(root, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue
    const directory = join(root, versionEntry.name)
    if (!existsSync(join(directory, 'package.json'))) continue
    const pkg = readJsonFile<{ version?: unknown }>(join(directory, 'package.json'))
    const version = typeof pkg?.version === 'string' && pkg.version.trim()
      ? pkg.version.trim().replace(/^v/, '')
      : versionEntry.name
    installed.push({
      version,
      directory,
      active: activeDir === resolve(directory),
    })
  }

  return installed.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
}

async function fetchRemoteVersions(): Promise<{ manifest: RemoteVersionManifest | null; error: string }> {
  const url = process.env.HERMES_WEB_UI_VERSION_MANIFEST_URL?.trim() || DEFAULT_REMOTE_MANIFEST_URL
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { manifest: null, error: `GET ${url} returned ${response.status}` }
    return { manifest: await response.json() as RemoteVersionManifest, error: '' }
  } catch (err) {
    return { manifest: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getRuntimeVersionStatus(): Promise<RuntimeVersionStatus> {
  const active = readActiveVersionManifest()
  const { manifest, error } = await fetchRemoteVersions()
  const webUiVersion = getHermesWebUiVersion()

  return {
    active,
    platform: runtimePlatformKey(),
    activeVersionPath: activeVersionPath(),
    remoteManifestUrl: process.env.HERMES_WEB_UI_VERSION_MANIFEST_URL?.trim() || DEFAULT_REMOTE_MANIFEST_URL,
    remoteError: error,
    hermes: {
      activeVersion: active?.hermesRuntimeVersion || '',
      activeDirectory: active?.runtimeDirectory || '',
      installed: listInstalledRuntimeVersions(active),
      remoteVersions: normalizeStringList(manifest?.hermes),
    },
    webui: {
      currentVersion: webUiVersion,
      activeVersion: active?.webUiVersion || webUiVersion,
      activeDirectory: active?.webUiDirectory || '',
      installed: listInstalledWebUiVersions(active),
      remoteVersions: normalizeStringList(manifest?.webui),
    },
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
  return await response.json() as T
}

function downloadFile(url: string, target: string, onProgress?: DownloadProgressHandler, redirects = 5): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
    const req = getter(parsed, response => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume()
        downloadFile(new URL(location, url).toString(), target, onProgress, redirects - 1).then(resolvePromise, rejectPromise)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        rejectPromise(new Error(`GET ${url} returned ${status}`))
        return
      }

      const totalBytes = Number(response.headers['content-length']) || undefined
      let receivedBytes = 0
      response.on('data', chunk => {
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        onProgress?.({
          stage: 'download',
          message: 'runtimeVersions.jobStage.download',
          percent: totalBytes ? Math.min(99, (receivedBytes / totalBytes) * 100) : undefined,
          receivedBytes,
          totalBytes,
        })
      })

      const file = createWriteStream(target)
      response.pipe(file)
      file.on('finish', () => file.close(() => resolvePromise()))
      file.on('error', rejectPromise)
    })
    req.on('error', err => {
      rejectPromise(new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`))
    })
  })
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolvePromise)
    stream.on('error', rejectPromise)
  })
  return hash.digest('hex')
}

async function extractTarGzip(archive: string, targetRoot: string): Promise<void> {
  await tar.x({
    file: archive,
    cwd: targetRoot,
    preserveOwner: false,
    unlink: true,
  })
}

export async function downloadRuntimeVersion(version: string, source: VersionDownloadSource, onProgress?: DownloadProgressHandler): Promise<InstalledRuntimeVersion> {
  const cleanVersion = version.trim()
  if (!cleanVersion) throw new Error('Runtime version is required')

  const platform = runtimePlatformKey()
  const releaseTag = `hermes-${cleanVersion}-runtime`
  const manifestName = `hermes-runtime-${platform}.json`
  const manifestUrl = downloadAssetUrl(manifestName, releaseTag, source)
  onProgress?.({ stage: 'resolve', message: 'runtimeVersions.jobStage.resolveRuntime' })
  const manifest = await fetchJson<RuntimePackageManifest>(manifestUrl)
  const asset = manifest.asset
  if (!asset?.name) throw new Error(`Runtime manifest is missing asset.name: ${manifestUrl}`)
  const assetName = asset.name

  const assetUrl = downloadAssetUrl(assetName, releaseTag, source)
  const targetRoot = join(desktopRuntimeRoot(), 'hermes', cleanVersion, platform)
  const archive = join(desktopRuntimeRoot(), `${basename(assetName)}.download`)
  const tempRoot = join(desktopRuntimeRoot(), `.runtime-download-${process.pid}-${Date.now()}`)

  mkdirSync(desktopRuntimeRoot(), { recursive: true })
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    await downloadFile(assetUrl, archive, onProgress)
    onProgress?.({ stage: 'verify', message: 'runtimeVersions.jobStage.verifyRuntime', percent: 100 })
    if (asset.sha256) {
      const actual = await sha256File(archive)
      if (actual !== asset.sha256) throw new Error(`Runtime checksum mismatch for ${assetName}`)
    }
    onProgress?.({ stage: 'extract', message: 'runtimeVersions.jobStage.extractRuntime' })
    await extractTarGzip(archive, tempRoot)
    const missing = missingRuntimeFiles(tempRoot)
    if (missing.length > 0) {
      throw new Error(`Runtime archive is missing required files: ${missing.map(file => relative(tempRoot, file)).join(', ')}`)
    }
    onProgress?.({ stage: 'install', message: 'runtimeVersions.jobStage.installRuntime' })
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    renameSync(tempRoot, targetRoot)
  } finally {
    rmSync(archive, { force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }

  return {
    version: cleanVersion,
    platform,
    directory: targetRoot,
    active: false,
    manifestHermesRuntimeVersion: manifest.hermesAgentVersion || cleanVersion,
  }
}

export async function downloadWebUiVersion(version: string, source: VersionDownloadSource, onProgress?: DownloadProgressHandler): Promise<InstalledWebUiVersion> {
  const cleanVersion = version.trim().replace(/^v/, '')
  if (!cleanVersion) throw new Error('Web UI version is required')

  const releaseTag = `v${cleanVersion}`
  const assetName = `hermes-web-ui-${cleanVersion}.tar.gz`
  const manifestName = `hermes-web-ui-${cleanVersion}.json`
  const manifestUrl = downloadAssetUrl(manifestName, releaseTag, source)
  onProgress?.({ stage: 'resolve', message: 'runtimeVersions.jobStage.resolveWebUi' })
  const manifest = await fetchJson<{ asset?: { sha256?: string; size?: number } }>(manifestUrl)
  const archive = join(desktopRuntimeRoot(), `${assetName}.download`)
  const tempRoot = join(desktopRuntimeRoot(), `.webui-download-${process.pid}-${Date.now()}`)
  const targetRoot = join(config.appHome, 'webui', cleanVersion)
  const assetUrl = downloadAssetUrl(assetName, releaseTag, source)

  mkdirSync(desktopRuntimeRoot(), { recursive: true })
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    await downloadFile(assetUrl, archive, onProgress)
    onProgress?.({ stage: 'verify', message: 'runtimeVersions.jobStage.verifyWebUi', percent: 100 })
    if (manifest.asset?.sha256) {
      const actual = await sha256File(archive)
      if (actual !== manifest.asset.sha256) throw new Error(`Web UI checksum mismatch for ${assetName}`)
    }
    onProgress?.({ stage: 'extract', message: 'runtimeVersions.jobStage.extractWebUi' })
    await extractTarGzip(archive, tempRoot)
    const extractedRoot = join(tempRoot, 'webui')
    for (const required of ['package.json', 'bin/hermes-web-ui.mjs', 'dist/server/index.js']) {
      if (!existsSync(join(extractedRoot, required))) throw new Error(`Web UI archive is missing required file: ${required}`)
    }
    onProgress?.({ stage: 'install', message: 'runtimeVersions.jobStage.installWebUi' })
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    renameSync(extractedRoot, targetRoot)
  } finally {
    rmSync(archive, { force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }

  return { version: cleanVersion, directory: targetRoot, active: false }
}

export function activateInstalledRuntimeVersion(version: string): ActiveVersionManifest {
  const cleanVersion = version.trim()
  if (!cleanVersion) throw new Error('Runtime version is required')

  const active = readActiveVersionManifest()
  const installed = listInstalledRuntimeVersions(active)
  const target = installed.find(item => item.version === cleanVersion && item.platform === runtimePlatformKey())
  if (!target) throw new Error(`Installed runtime version not found for this platform: ${cleanVersion}`)

  const next: ActiveVersionManifest = {
    schema: 1,
    hermesRuntimeVersion: target.manifestHermesRuntimeVersion || target.version,
    webUiVersion: active?.webUiVersion || getHermesWebUiVersion(),
    runtimeDirectory: target.directory,
    webUiDirectory: active?.webUiDirectory || '',
    platform: target.platform,
    updatedAt: new Date().toISOString(),
  }

  mkdirSync(dirname(activeVersionPath()), { recursive: true })
  writeFileSync(activeVersionPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return next
}

export function deleteInstalledRuntimeVersion(version: string): InstalledRuntimeVersion {
  const cleanVersion = version.trim()
  if (!cleanVersion) throw new Error('Runtime version is required')

  const active = readActiveVersionManifest()
  const installed = listInstalledRuntimeVersions(active)
  const target = installed.find(item => item.version === cleanVersion && item.platform === runtimePlatformKey())
  if (!target) throw new Error(`Installed runtime version not found for this platform: ${cleanVersion}`)
  if (target.active) throw new Error('Active runtime version cannot be deleted')

  rmSync(target.directory, { recursive: true, force: true })
  try {
    const versionRoot = dirname(target.directory)
    if (existsSync(versionRoot) && readdirSync(versionRoot).length === 0) {
      rmSync(versionRoot, { recursive: true, force: true })
    }
  } catch {
    /* ignore empty parent cleanup failures */
  }
  return target
}

export function activateDownloadedWebUiVersion(version: string): ActiveVersionManifest {
  const cleanVersion = version.trim().replace(/^v/, '')
  if (!cleanVersion) throw new Error('Web UI version is required')
  const directory = join(config.appHome, 'webui', cleanVersion)
  if (!existsSync(join(directory, 'package.json'))) throw new Error(`Downloaded Web UI version not found: ${cleanVersion}`)
  const active = readActiveVersionManifest()
  const next: ActiveVersionManifest = {
    schema: 1,
    hermesRuntimeVersion: active?.hermesRuntimeVersion || '',
    webUiVersion: cleanVersion,
    runtimeDirectory: active?.runtimeDirectory || '',
    webUiDirectory: directory,
    platform: active?.platform || runtimePlatformKey(),
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(activeVersionPath()), { recursive: true })
  writeFileSync(activeVersionPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return next
}

export function deleteDownloadedWebUiVersion(version: string): InstalledWebUiVersion {
  const cleanVersion = version.trim().replace(/^v/, '')
  if (!cleanVersion) throw new Error('Web UI version is required')

  const active = readActiveVersionManifest()
  const installed = listInstalledWebUiVersions(active)
  const target = installed.find(item => item.version === cleanVersion)
  if (!target) throw new Error(`Downloaded Web UI version not found: ${cleanVersion}`)
  if (target.active) throw new Error('Active Web UI version cannot be deleted')

  const webUiRoot = resolve(join(config.appHome, 'webui'))
  const targetDir = resolve(target.directory)
  const rel = relative(webUiRoot, targetDir)
  if (!rel || rel.startsWith('..') || rel === '..') {
    throw new Error('Only downloaded Web UI versions can be deleted')
  }

  rmSync(targetDir, { recursive: true, force: true })
  return target
}

const versionDownloadJobs = new Map<string, VersionDownloadJob>()

function cloneJob(job: VersionDownloadJob): VersionDownloadJob {
  return { ...job, result: job.result ? { ...job.result } : undefined }
}

function createDownloadJob(
  kind: VersionDownloadKind,
  source: VersionDownloadSource,
  version: string,
  runner: (cleanVersion: string, onProgress: DownloadProgressHandler) => Promise<InstalledRuntimeVersion | InstalledWebUiVersion>,
): VersionDownloadJob {
  const cleanVersion = version.trim().replace(/^v/, '')
  if (!cleanVersion) throw new Error(`${kind === 'runtime' ? 'Runtime' : 'Web UI'} version is required`)

  const existing = Array.from(versionDownloadJobs.values()).find(job =>
    job.kind === kind &&
    job.version === cleanVersion &&
    (job.status === 'queued' || job.status === 'running'),
  )
  if (existing) return cloneJob(existing)

  const now = new Date().toISOString()
  const job: VersionDownloadJob = {
    id: `${kind}-${cleanVersion}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    source,
    version: cleanVersion,
    status: 'queued',
    stage: 'queued',
    message: 'runtimeVersions.jobStage.queued',
    error: '',
    createdAt: now,
    updatedAt: now,
  }
  versionDownloadJobs.set(job.id, job)

  const updateProgress: DownloadProgressHandler = progress => {
    job.stage = progress.stage
    job.message = progress.message
    job.percent = progress.percent
    job.receivedBytes = progress.receivedBytes
    job.totalBytes = progress.totalBytes
    job.updatedAt = new Date().toISOString()
  }

  queueMicrotask(() => {
    job.status = 'running'
    updateProgress({
      stage: 'resolve',
      message: kind === 'runtime' ? 'runtimeVersions.jobStage.resolveRuntime' : 'runtimeVersions.jobStage.resolveWebUi',
    })

    runner(cleanVersion, updateProgress)
      .then(result => {
        job.status = 'completed'
        job.stage = 'completed'
        job.message = 'runtimeVersions.jobStage.completed'
        job.percent = 100
        job.result = result
        job.updatedAt = new Date().toISOString()
      })
      .catch(err => {
        job.status = 'failed'
        job.stage = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
        job.message = 'runtimeVersions.jobStage.failed'
        job.updatedAt = new Date().toISOString()
      })
  })

  return cloneJob(job)
}

export function startRuntimeVersionDownload(version: string, source: VersionDownloadSource): VersionDownloadJob {
  return createDownloadJob('runtime', source, version, (cleanVersion, onProgress) => downloadRuntimeVersion(cleanVersion, source, onProgress))
}

export function startWebUiVersionDownload(version: string, source: VersionDownloadSource): VersionDownloadJob {
  return createDownloadJob('webui', source, version, (cleanVersion, onProgress) => downloadWebUiVersion(cleanVersion, source, onProgress))
}

export function listVersionDownloadJobs(): VersionDownloadJob[] {
  return Array.from(versionDownloadJobs.values())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(cloneJob)
}

export function getVersionDownloadJob(id: string): VersionDownloadJob | null {
  const job = versionDownloadJobs.get(id)
  return job ? cloneJob(job) : null
}
