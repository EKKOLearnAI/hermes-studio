import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { access, mkdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { getProfileDir } from './hermes-profile'

type PackageInfo = {
  name: string
  version: string
}

interface PackumentResponse {
  versions?: Record<string, unknown>
}

const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000

let cachedReleases: string[] = []
let cachedAt = 0

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    resolve(__dirname, '../../../../package.json'),
    resolve(__dirname, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]

  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue

    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (pkg?.name && pkg?.version) {
        return {
          name: String(pkg.name),
          version: String(pkg.version),
        }
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return null
}

function packageName(): string {
  return readPackageInfo()?.name || 'hermes-web-ui'
}

function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease: Array<string | number> } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split('.').map((segment) => {
        if (/^\d+$/.test(segment)) return Number(segment)
        return segment
      })
      : [],
  }
}

function comparePrereleaseDesc(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return -1
  if (b.length === 0) return 1

  const len = Math.max(a.length, b.length)
  for (let index = 0; index < len; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return 1
    if (right === undefined) return -1
    if (left === right) continue

    const leftIsNumber = typeof left === 'number'
    const rightIsNumber = typeof right === 'number'
    if (leftIsNumber && rightIsNumber) return (right as number) - (left as number)
    if (leftIsNumber) return 1
    if (rightIsNumber) return -1
    return String(right).localeCompare(String(left), 'en', { sensitivity: 'base' })
  }

  return 0
}

function compareVersionsDesc(leftVersion: string, rightVersion: string): number {
  const left = parseSemver(leftVersion)
  const right = parseSemver(rightVersion)

  if (!left || !right) {
    return rightVersion.localeCompare(leftVersion, 'en', { numeric: true, sensitivity: 'base' })
  }

  if (left.major !== right.major) return right.major - left.major
  if (left.minor !== right.minor) return right.minor - left.minor
  if (left.patch !== right.patch) return right.patch - left.patch
  return comparePrereleaseDesc(left.prerelease, right.prerelease)
}

async function fetchPackument(packageNameValue: string): Promise<PackumentResponse | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageNameValue)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return await res.json() as PackumentResponse
  } catch {
    return null
  }
}

export async function listAvailableReleases(force = false): Promise<string[]> {
  if (!force && cachedReleases.length > 0 && Date.now() - cachedAt < RELEASE_CACHE_TTL_MS) {
    return [...cachedReleases]
  }

  const packument = await fetchPackument(packageName())
  const releases = Object.keys(packument?.versions || {})
    .filter((version) => version.trim().length > 0)
    .sort(compareVersionsDesc)

  cachedReleases = releases
  cachedAt = Date.now()
  return [...releases]
}

export async function getLatestAvailableRelease(): Promise<string | null> {
  const releases = await listAvailableReleases()
  return releases[0] || null
}

function sanitizeReleaseVersion(version: string): string {
  const normalized = version.trim()
  if (!/^v?[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(normalized)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  return normalized
}

function releaseCacheRoot(profile: string): string {
  return join(getProfileDir(profile), '.webui-release-previews')
}

function releasePackagePath(profile: string, version: string): string {
  return join(releaseCacheRoot(profile), sanitizeReleaseVersion(version), 'package')
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

async function assertReleasePreviewRoot(packagePath: string): Promise<void> {
  await access(join(packagePath, 'dist', 'client', 'index.html'))
}

export async function prepareReleasePreviewPackage(profile: string, version: string): Promise<string> {
  const safeVersion = sanitizeReleaseVersion(version)
  const packagePath = releasePackagePath(profile, safeVersion)
  try {
    await assertReleasePreviewRoot(packagePath)
    return packagePath
  } catch {
    // Populate below.
  }

  const root = releaseCacheRoot(profile)
  const versionRoot = join(root, safeVersion)
  const tarballDir = join(versionRoot, 'tarball')
  await rm(versionRoot, { recursive: true, force: true })
  await mkdir(tarballDir, { recursive: true })
  await mkdir(packagePath, { recursive: true })

  const pack = await runCommand('npm', ['pack', `${packageName()}@${safeVersion}`, '--pack-destination', tarballDir, '--json'], tarballDir)
  if (pack.code !== 0) {
    throw new Error(pack.stderr.trim() || `Failed to download release ${safeVersion}`)
  }

  let filename = ''
  try {
    const parsed = JSON.parse(pack.stdout.trim())
    filename = Array.isArray(parsed) ? String(parsed[0]?.filename || '') : String(parsed?.filename || '')
  } catch {
    filename = pack.stdout.trim().split(/\r?\n/).pop() || ''
  }
  if (!filename) {
    throw new Error(`Failed to identify release tarball for ${safeVersion}`)
  }

  const tarballPath = join(tarballDir, filename)
  const extract = await runCommand('tar', ['-xzf', tarballPath, '-C', packagePath, '--strip-components=1'], tarballDir)
  if (extract.code !== 0) {
    throw new Error(extract.stderr.trim() || `Failed to extract release ${safeVersion}`)
  }

  await assertReleasePreviewRoot(packagePath)
  return packagePath
}
