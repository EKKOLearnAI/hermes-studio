import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { accessSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { get as httpGet } from 'http'
import { get as httpsGet } from 'https'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import * as tar from 'tar'
import { config } from '../config'
import { getHermesAgentVersion, getHermesWebUiVersion } from './system-info'

const ACTIVE_VERSION_FILE = 'active-version.json'
const DEFAULT_REMOTE_MANIFEST_URL = 'https://api.hermes-studio.ai/api/studio/versions'
const FALLBACK_REMOTE_MANIFEST_URL = 'https://hermes-studio.ai/versions.json'
const DEFAULT_DOWNLOAD_BASE_URL = 'https://download.ekkolearnai.com'
const DEFAULT_GITHUB_REPO = 'EKKOLearnAI/hermes-studio'

export interface ActiveVersionManifest {
  schema: number
  desktopAppVersion?: string
  hermesRuntimeVersion?: string
  webUiVersion?: string
  runtimeDirectory?: string
  runtimeRootDirectory?: string
  pendingRuntimeRootDirectory?: string
  runtimeMigrationError?: string
  runtimeActivationError?: string
  webUiDirectory?: string
  platform?: string
  updatedAt?: string
  /** Warning about pip packages missing in the newly activated runtime. */
  _pipMissingWarning?: string
  /** Pip packages from a deleted runtime that may need reinstallation. */
  _orphanedPipPackages?: string[]
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

export interface StudioVersionManifest {
  schema?: number
  hermes?: string[]
  mobile?: unknown
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
    agentVersion: string
    activeDirectory: string
    storageDirectory: string
    defaultStorageDirectory: string
    pendingStorageDirectory: string
    migrationError: string
    activationError: string
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
  schema?: number
  hermesAgentVersion?: string
  platform?: string
  hermesSource?: {
    repository?: string
    ref?: string
    commit?: string
    installMethod?: string
  }
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

function defaultDesktopRuntimeRoot(): string {
  return join(config.appHome, 'desktop-runtime')
}

function activeVersionPath(): string {
  return join(defaultDesktopRuntimeRoot(), ACTIVE_VERSION_FILE)
}

function runtimeStorageRoot(active = readActiveVersionManifest()): string {
  const configured = active?.runtimeRootDirectory?.trim()
  return configured ? resolve(configured) : defaultDesktopRuntimeRoot()
}

function webUiStorageRoot(active = readActiveVersionManifest()): string {
  return join(runtimeStorageRoot(active), 'webui')
}

function activeWebUiDirectory(active = readActiveVersionManifest()): string {
  const version = active?.webUiVersion?.trim().replace(/^v/, '')
  return version ? join(webUiStorageRoot(active), version) : ''
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
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

function requiredRuntimeFileGroups(root: string): string[][] {
  const sourceRoot = join(root, 'python')
  const venvRoot = join(sourceRoot, 'venv')
  const venvPythons = process.platform === 'win32'
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')]
    : [join(venvRoot, 'bin', 'python3')]
  const pythonRoot = venvPythons.some(existsSync) ? venvRoot : sourceRoot
  const standardVenvPython = join(pythonRoot, 'Scripts', 'python.exe')
  const pythonBin = process.platform === 'win32'
    ? existsSync(standardVenvPython) ? standardVenvPython : join(pythonRoot, 'python.exe')
    : join(pythonRoot, 'bin', 'python3')
  const hermesBins = process.platform === 'win32'
    ? [
        join(pythonRoot, 'Scripts', 'hermes.cmd'),
        join(pythonRoot, 'Scripts', 'hermes.exe'),
      ]
    : [join(pythonRoot, 'bin', 'hermes')]
  const nodeBin = process.platform === 'win32'
    ? join(root, 'node', 'node.exe')
    : join(root, 'node', 'bin', 'node')
  const groups = [[pythonBin], hermesBins, [nodeBin], [join(root, 'runtime-manifest.json')]]
  if (process.platform === 'win32') groups.push([join(root, 'git', 'cmd', 'git.exe')])
  return groups
}

function missingRuntimeFiles(root: string): string[] {
  return requiredRuntimeFileGroups(root)
    .filter(files => !files.some(existsSync))
    .map(files => files.map(file => relative(root, file)).join(' or '))
}

function validateRuntimeDirectory(root: string, expectedPlatform: string): void {
  const missing = missingRuntimeFiles(root)
  if (missing.length > 0) {
    throw new Error(
      `Runtime is missing required files: `
      + missing.join(', '),
    )
  }
  const manifest = readJsonFile<RuntimePackageManifest>(join(root, 'runtime-manifest.json'))
  if (!manifest) throw new Error('Runtime has an invalid runtime-manifest.json')
  if (manifest.platform && manifest.platform !== expectedPlatform) {
    throw new Error(`Runtime platform mismatch: expected ${expectedPlatform}, received ${manifest.platform}`)
  }
  if ((manifest.schema || 0) >= 2) {
    const missingSource = [
      join(root, 'python', '.git', 'HEAD'),
      join(root, 'python', 'pyproject.toml'),
    ].filter(file => !existsSync(file))
    if (missingSource.length > 0) {
      throw new Error(
        `Runtime archive is missing updateable Hermes source files: `
        + missingSource.map(file => relative(root, file)).join(', '),
      )
    }
    if (manifest.hermesSource?.installMethod !== 'git'
      || !manifest.hermesSource.repository
      || !manifest.hermesSource.ref
      || !/^[0-9a-f]{40}$/i.test(manifest.hermesSource.commit || '')) {
      throw new Error('Runtime archive has invalid Hermes Git source metadata')
    }
  }
}

function scanInstalledRuntimeVersions(active = readActiveVersionManifest()): InstalledRuntimeVersion[] {
  const root = join(runtimeStorageRoot(active), 'hermes')
  const currentPlatform = runtimePlatformKey()
  const activeDir = active?.runtimeDirectory ? resolve(active.runtimeDirectory) : ''
  const installed: InstalledRuntimeVersion[] = []

  if (existsSync(root)) {
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
  }

  if (activeDir && !installed.some(item => resolve(item.directory) === activeDir)) {
    const manifestVersion = readRuntimeManifestVersion(activeDir)
    installed.push({
      version: active?.hermesRuntimeVersion || manifestVersion || basename(activeDir),
      platform: active?.platform || currentPlatform,
      directory: activeDir,
      active: true,
      manifestHermesRuntimeVersion: manifestVersion,
    })
  }

  return installed
}

export function listInstalledRuntimeVersions(active = readActiveVersionManifest()): InstalledRuntimeVersion[] {
  const currentPlatform = runtimePlatformKey()
  const installed = scanInstalledRuntimeVersions(active)
    .filter(item => {
      try {
        validateRuntimeDirectory(item.directory, item.platform)
        return true
      } catch {
        return false
      }
    })

  return installed.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    if (left.platform === currentPlatform && right.platform !== currentPlatform) return -1
    if (right.platform === currentPlatform && left.platform !== currentPlatform) return 1
    return right.version.localeCompare(left.version, undefined, { numeric: true })
  })
}

export function listInstalledWebUiVersions(active = readActiveVersionManifest()): InstalledWebUiVersion[] {
  const root = webUiStorageRoot(active)
  if (!existsSync(root)) return []

  const activeDir = activeWebUiDirectory(active)
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

function isStudioVersionManifest(value: unknown): value is StudioVersionManifest {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as StudioVersionManifest).hermes)
}

async function fetchVersionManifest(url: string): Promise<StudioVersionManifest> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
  const manifest: unknown = await response.json()
  if (!isStudioVersionManifest(manifest)) throw new Error(`GET ${url} returned an invalid version manifest`)
  return manifest
}

async function fetchRemoteVersions(): Promise<{ manifest: StudioVersionManifest | null; error: string }> {
  const primaryUrl = process.env.HERMES_WEB_UI_VERSION_MANIFEST_URL?.trim() || DEFAULT_REMOTE_MANIFEST_URL
  try {
    return { manifest: await fetchVersionManifest(primaryUrl), error: '' }
  } catch (primaryError) {
    if (primaryUrl === FALLBACK_REMOTE_MANIFEST_URL) {
      return { manifest: null, error: primaryError instanceof Error ? primaryError.message : String(primaryError) }
    }
    try {
      return { manifest: await fetchVersionManifest(FALLBACK_REMOTE_MANIFEST_URL), error: '' }
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError)
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      return { manifest: null, error: `${primaryMessage}; fallback failed: ${fallbackMessage}` }
    }
  }
}

export async function getRuntimeVersionStatus(): Promise<RuntimeVersionStatus> {
  const active = readActiveVersionManifest()
  const [{ manifest, error }, agentVersion] = await Promise.all([
    fetchRemoteVersions(),
    getHermesAgentVersion(),
  ])
  const webUiVersion = getHermesWebUiVersion()

  return {
    active,
    platform: runtimePlatformKey(),
    activeVersionPath: activeVersionPath(),
    remoteManifestUrl: process.env.HERMES_WEB_UI_VERSION_MANIFEST_URL?.trim() || DEFAULT_REMOTE_MANIFEST_URL,
    remoteError: error,
    hermes: {
      activeVersion: active?.hermesRuntimeVersion || '',
      agentVersion,
      activeDirectory: active?.runtimeDirectory || '',
      storageDirectory: runtimeStorageRoot(active),
      defaultStorageDirectory: defaultDesktopRuntimeRoot(),
      pendingStorageDirectory: active?.pendingRuntimeRootDirectory || '',
      migrationError: active?.runtimeMigrationError || '',
      activationError: active?.runtimeActivationError || '',
      installed: listInstalledRuntimeVersions(active),
      remoteVersions: normalizeStringList(manifest?.hermes),
    },
    webui: {
      currentVersion: webUiVersion,
      activeVersion: active?.webUiVersion || webUiVersion,
      activeDirectory: activeWebUiDirectory(active),
      installed: listInstalledWebUiVersions(active),
      remoteVersions: [],
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
  const storageRoot = runtimeStorageRoot()
  const targetRoot = join(storageRoot, 'hermes', cleanVersion, platform)
  const archive = join(storageRoot, `${basename(assetName)}.download`)
  const tempRoot = join(storageRoot, `.runtime-download-${process.pid}-${Date.now()}`)

  mkdirSync(storageRoot, { recursive: true })
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
    validateRuntimeDirectory(tempRoot, platform)
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
  const storageRoot = runtimeStorageRoot()
  const archive = join(storageRoot, `${assetName}.download`)
  const tempRoot = join(storageRoot, `.webui-download-${process.pid}-${Date.now()}`)
  const targetRoot = join(storageRoot, 'webui', cleanVersion)
  const assetUrl = downloadAssetUrl(assetName, releaseTag, source)

  mkdirSync(storageRoot, { recursive: true })
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

interface PipPackageDiff {
  missing: string[]
}

/**
 * Normalize a pip package name per PEP 503: lowercase, replace runs of [-_.] with '-'.
 * This ensures robust comparison between names returned by `pip list --format=json`
 * (which preserves the metadata name, e.g. slack_sdk) and our BASE_PACKAGES entries.
 */
function normalizePkgName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * Set of "base" pip packages that ship with every Hermes runtime (known by name).
 * All entries use the PEP 503 normalized form (lowercase, hyphens).
 * Kept at module level so both diffUserInstalledPipPackages() and
 * deleteInstalledRuntimeVersion() can reference it.
 */
const BASE_PACKAGES = new Set([
  'hermes-agent', 'aiohttp', 'httpx', 'fastapi', 'uvicorn', 'pydantic',
  'pyyaml', 'requests', 'certifi', 'urllib3', 'idna', 'charset-normalizer',
  'click', 'colorama', 'jinja2', 'rich', 'typer', 'setuptools', 'pip',
  'websockets', 'cryptography', 'pywin32', 'psutil', 'prompt-toolkit',
  'python-telegram-bot', 'discord-py', 'slack-sdk', 'slack-bolt',
  'lark-oapi', 'dingtalk-stream', 'edge-tts', 'pillow',
])

function diffUserInstalledPipPackages(
  oldRuntimeDir: string,
  newRuntimeDir: string,
): PipPackageDiff {
  const pythonBin = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')
  const oldPython = join(oldRuntimeDir, 'python', pythonBin)
  const newPython = join(newRuntimeDir, 'python', pythonBin)
  if (!existsSync(oldPython) || !existsSync(newPython)) {
    return { missing: [] }
  }

  try {
    const result = execFileSync(oldPython, [
      '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'
    ], { encoding: 'utf-8', timeout: 15000, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] })
    const oldPkgs: Array<{ name: string; version: string }> = JSON.parse(result.trim())

    const userPkgs = oldPkgs
      .map(p => normalizePkgName(p.name))
      .filter(name => !BASE_PACKAGES.has(name) && !name.startsWith('opentelemetry'))

    if (userPkgs.length === 0) return { missing: [] }

    const newResult = execFileSync(newPython, [
      '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'
    ], { encoding: 'utf-8', timeout: 15000, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] })
    const newPkgs = new Set(
      (JSON.parse(newResult.trim()) as Array<{ name: string }>).map(p => normalizePkgName(p.name))
    )

    const missing = userPkgs.filter(name => !newPkgs.has(name))
    return { missing }
  } catch (err) {
    console.error('[runtime] Failed to diff pip packages:', err instanceof Error ? err.message : String(err))
    return { missing: [] }
  }
}

export function activateInstalledRuntimeVersion(version: string): ActiveVersionManifest {
  const cleanVersion = version.trim()
  if (!cleanVersion) throw new Error('Runtime version is required')

  const active = readActiveVersionManifest()
  const installed = scanInstalledRuntimeVersions(active)
  const target = installed.find(item => item.version === cleanVersion && item.platform === runtimePlatformKey())
  if (!target) throw new Error(`Installed runtime version not found for this platform: ${cleanVersion}`)
  try {
    validateRuntimeDirectory(target.directory, target.platform)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Runtime ${cleanVersion} cannot be activated: ${detail}`)
  }

  // Detect pip packages that existed in the previous runtime but are missing in the new one
  let missingPackagesWarning: string | undefined
  if (active?.runtimeDirectory) {
    const diff = diffUserInstalledPipPackages(active.runtimeDirectory, target.directory)
    if (diff.missing.length > 0) {
      missingPackagesWarning = [
        `The new Hermes runtime is missing ${diff.missing.length} pip package(s) that were installed in the previous runtime:`,
        ...diff.missing.map(p => `  - ${p}`),
        '',
        'To install them, run:',
        `  "${join(target.directory, 'python', process.platform === 'win32' ? 'python.exe' : 'bin', 'python3')}" -m pip install ${diff.missing.join(' ')}`,
      ].join('\n')
      console.warn(`[runtime] ${missingPackagesWarning}`)
    }
  }

  // Also surface orphaned packages from previously deleted runtimes.
  // Validate against the new runtime's pip list to avoid false positives
  // (e.g. the user already reinstalled them manually).
  if (active?._orphanedPipPackages?.length) {
    const pythonBin = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')
    const newPythonPath = join(target.directory, 'python', pythonBin)
    let stillMissing = active._orphanedPipPackages
    if (existsSync(newPythonPath)) {
      try {
        const newResult = execFileSync(newPythonPath, [
          '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'
        ], { encoding: 'utf-8', timeout: 15000, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] })
        const newPkgs = new Set(
          (JSON.parse(newResult.trim()) as Array<{ name: string }>).map(p => normalizePkgName(p.name))
        )
        stillMissing = active._orphanedPipPackages.filter(name => !newPkgs.has(name))
      } catch (err) {
        console.error('[runtime] Failed to validate orphaned packages:',
          err instanceof Error ? err.message : String(err))
      }
    }
    if (stillMissing.length > 0) {
      const orphanWarning = [
        `The following pip package(s) were installed in a deleted runtime and are missing in the current one:`,
        ...stillMissing.map(p => `  - ${p}`),
        '',
        'To install them, run:',
        `  "${join(target.directory, 'python', process.platform === 'win32' ? 'python.exe' : 'bin', 'python3')}" -m pip install ${stillMissing.join(' ')}`,
      ].join('\n')
      if (missingPackagesWarning) {
        missingPackagesWarning += '\n\n' + orphanWarning
      } else {
        missingPackagesWarning = orphanWarning
      }
      console.warn(`[runtime] ${orphanWarning}`)
    }
  }

  const next: ActiveVersionManifest = {
    schema: 1,
    desktopAppVersion: active?.desktopAppVersion || undefined,
    hermesRuntimeVersion: target.manifestHermesRuntimeVersion || target.version,
    webUiVersion: active?.webUiVersion || undefined,
    runtimeDirectory: target.directory,
    runtimeRootDirectory: active?.runtimeRootDirectory || '',
    pendingRuntimeRootDirectory: active?.pendingRuntimeRootDirectory || '',
    runtimeMigrationError: active?.runtimeMigrationError || '',
    runtimeActivationError: '',
    platform: target.platform,
    updatedAt: new Date().toISOString(),
    _pipMissingWarning: missingPackagesWarning,
  }

  mkdirSync(dirname(activeVersionPath()), { recursive: true })
  writeFileSync(activeVersionPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return next
}

export function scheduleRuntimeRootMigration(directory: string): ActiveVersionManifest {
  const selectedDirectory = directory.trim()
  if (!selectedDirectory) throw new Error('Runtime storage directory is required')
  if (process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()) {
    throw new Error('Runtime storage directory cannot be changed while HERMES_DESKTOP_RUNTIME_DIR is set')
  }

  const target = resolve(selectedDirectory)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error('Runtime storage directory must be an existing directory')
  }
  try {
    accessSync(target, constants.W_OK)
  } catch {
    throw new Error('Runtime storage directory is not writable')
  }

  const active = readActiveVersionManifest()
  const currentRoot = runtimeStorageRoot(active)
  if (target !== resolve(currentRoot) && isSameOrNestedPath(currentRoot, target)) {
    throw new Error('Runtime storage directory cannot be inside the current Runtime storage directory')
  }
  if (active?.runtimeDirectory && isSameOrNestedPath(active.runtimeDirectory, target)) {
    throw new Error('Runtime storage directory cannot be the current Runtime directory or one of its subdirectories')
  }

  const next: ActiveVersionManifest = {
    ...(active || { schema: 1 }),
    schema: 1,
    pendingRuntimeRootDirectory: target === resolve(currentRoot) ? '' : target,
    runtimeMigrationError: '',
    updatedAt: new Date().toISOString(),
  }
  delete next.webUiDirectory

  mkdirSync(dirname(activeVersionPath()), { recursive: true })
  writeFileSync(activeVersionPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return next
}

export function deleteInstalledRuntimeVersion(version: string): InstalledRuntimeVersion {
  const cleanVersion = version.trim()
  if (!cleanVersion) throw new Error('Runtime version is required')

  const activeManifest = readActiveVersionManifest()
  const installed = listInstalledRuntimeVersions(activeManifest)
  const target = installed.find(item => item.version === cleanVersion && item.platform === runtimePlatformKey())
  if (!target) throw new Error(`Installed runtime version not found for this platform: ${cleanVersion}`)
  if (target.active) throw new Error('Active runtime version cannot be deleted')

  // Before deleting, collect user-installed pip packages so they can be
  // surfaced when the next runtime is activated.
  const pythonBin = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')
  const pythonPath = join(target.directory, 'python', pythonBin)
  if (existsSync(pythonPath)) {
    try {
      const result = execFileSync(pythonPath, [
        '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'
      ], { encoding: 'utf-8', timeout: 15000, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] })
      const pkgs: Array<{ name: string; version: string }> = JSON.parse(result.trim())
      const userPkgs = pkgs
        .map(p => normalizePkgName(p.name))
        .filter(name => !BASE_PACKAGES.has(name) && !name.startsWith('opentelemetry'))
      if (userPkgs.length > 0 && activeManifest) {
        // Merge with any existing orphans from previously deleted runtimes
        // to avoid silent data loss when deleting multiple runtimes in sequence.
        const existingOrphans = activeManifest._orphanedPipPackages || []
        activeManifest._orphanedPipPackages = [...new Set([...existingOrphans, ...userPkgs])]
        writeFileSync(activeVersionPath(), JSON.stringify(activeManifest, null, 2) + '\n', 'utf-8')
      }
    } catch (err) {
      console.error('[runtime] Failed to collect pip packages before deletion:',
        err instanceof Error ? err.message : String(err))
    }
  }

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
  const active = readActiveVersionManifest()
  const directory = join(webUiStorageRoot(active), cleanVersion)
  if (!existsSync(join(directory, 'package.json'))) throw new Error(`Downloaded Web UI version not found: ${cleanVersion}`)
  const next: ActiveVersionManifest = {
    schema: 1,
    desktopAppVersion: active?.desktopAppVersion || undefined,
    hermesRuntimeVersion: active?.hermesRuntimeVersion || '',
    webUiVersion: cleanVersion,
    runtimeDirectory: active?.runtimeDirectory || '',
    runtimeRootDirectory: active?.runtimeRootDirectory || '',
    pendingRuntimeRootDirectory: active?.pendingRuntimeRootDirectory || '',
    runtimeMigrationError: active?.runtimeMigrationError || '',
    runtimeActivationError: active?.runtimeActivationError || '',
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

  const webUiRoot = resolve(webUiStorageRoot(active))
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
