import { execFile } from 'node:child_process'
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
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  bundledGit,
  bundledNode,
  desktopRuntimeDir,
  hermesBinExists,
  runtimePlatformKey,
} from './paths'

const execFileAsync = promisify(execFile)
const DEFAULT_RUNTIME_BASE_URL = 'https://download.ekkolearnai.com'
const RUNTIME_MANIFEST_NAME = 'runtime-manifest.json'
const PACKAGED_RUNTIME_RELEASE_NAME = 'runtime-release.json'

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

export type RuntimeProgress = {
  stage: 'resolve' | 'download' | 'verify' | 'extract' | 'ready'
  message: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

type RuntimeProgressHandler = (progress: RuntimeProgress) => void

function runtimeReady(): boolean {
  const gitReady = process.platform !== 'win32' || !!bundledGit()
  return hermesBinExists() && existsSync(bundledNode()) && gitReady
}

function releaseTagCandidates(): string[] {
  const override = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG?.trim()
  if (override) return [override]

  const version = app.getVersion()
  const candidates = [packagedRuntimeReleaseTag(), version, `v${version}`, 'latest']
  return Array.from(new Set(candidates.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)))
}

function packagedRuntimeReleaseTag(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'build', PACKAGED_RUNTIME_RELEASE_NAME)]
    : [join(app.getAppPath(), 'build', PACKAGED_RUNTIME_RELEASE_NAME)]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as { tag?: unknown }
      if (typeof metadata.tag === 'string' && metadata.tag.trim()) return metadata.tag.trim()
    } catch {}
  }

  return null
}

function runtimeAssetUrl(assetName: string, tag: string): string {
  const repo = process.env.HERMES_DESKTOP_RUNTIME_REPO?.trim()
  if (repo) {
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
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`)
  }
  return await response.json() as T
}

async function resolveRuntimeDescriptor(): Promise<RuntimeDescriptor> {
  const directUrl = process.env.HERMES_DESKTOP_RUNTIME_URL?.trim()
  if (directUrl) {
    return { name: basename(new URL(directUrl).pathname) || 'hermes-runtime.tar.gz', url: directUrl }
  }

  const platformManifestName = `hermes-runtime-${runtimePlatformKey()}.json`
  const manifestOverride = process.env.HERMES_DESKTOP_RUNTIME_MANIFEST_URL?.trim()
  const candidates = manifestOverride
    ? [{ tag: '', url: manifestOverride }]
    : releaseTagCandidates().map(tag => ({ tag, url: runtimeAssetUrl(platformManifestName, tag) }))

  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const manifest = await fetchJson<RuntimeManifest>(candidate.url)
      if (!manifest.asset?.name) {
        throw new Error(`runtime manifest is missing asset.name: ${candidate.url}`)
      }
      return {
        name: manifest.asset.name,
        url: manifest.asset.url || runtimeAssetUrl(manifest.asset.name, candidate.tag),
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

function cachedRuntimeMatches(root: string, descriptor: RuntimeDescriptor): boolean {
  if (!runtimeReady()) return false
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
          message: 'Downloading Hermes runtime...',
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
    req.on('error', reject)
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
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archive, '-C', tempRoot], {
      windowsHide: true,
    })
    for (const required of ['python', 'node']) {
      if (!existsSync(join(tempRoot, required))) {
        throw new Error(`Runtime archive did not contain ${required}/`)
      }
    }
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
    renameSync(tempRoot, targetRoot)
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw err
  }
}

export async function ensureDesktopRuntime(onProgress?: RuntimeProgressHandler): Promise<void> {
  const runtimeRoot = desktopRuntimeDir()
  mkdirSync(runtimeRoot, { recursive: true })

  let descriptor: RuntimeDescriptor
  try {
    onProgress?.({ stage: 'resolve', message: 'Checking Hermes runtime...' })
    descriptor = await resolveRuntimeDescriptor()
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
  onProgress?.({ stage: 'download', message: `Downloading ${descriptor.name}...` })
  await downloadFile(descriptor.url, archive, onProgress)
  if (descriptor.sha256) {
    onProgress?.({ stage: 'verify', message: 'Verifying Hermes runtime...' })
    const actual = await sha256File(archive)
    if (actual !== descriptor.sha256) {
      throw new Error(`Runtime checksum mismatch for ${descriptor.name}`)
    }
  }

  onProgress?.({ stage: 'extract', message: 'Extracting Hermes runtime...' })
  await extractRuntimeArchive(archive, runtimeRoot)
  const archiveSize = statSync(archive).size
  rmSync(archive, { force: true })

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
  onProgress?.({ stage: 'ready', message: 'Hermes runtime ready.' })
  console.log(`[runtime] Hermes runtime ready at ${runtimeRoot}`)
}
