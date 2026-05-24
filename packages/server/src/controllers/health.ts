import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'

declare const __APP_VERSION__: string
declare const __APP_GIT_SHA__: string
declare const __APP_GIT_BRANCH__: string

type PackageInfo = {
  name: string
  version: string
}

type BuildInfo = {
  sha: string
  branch: string
}

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    // ts-node dev: packages/server/src/controllers -> repo root
    resolve(__dirname, '../../../../package.json'),
    // bundled server: dist/server -> repo root/package root
    resolve(__dirname, '../../package.json'),
    // fallback for dev/test processes started at the repo root
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

function readBuildInfo(): BuildInfo {
  const injectedSha = typeof __APP_GIT_SHA__ !== 'undefined' ? String(__APP_GIT_SHA__) : ''
  const injectedBranch = typeof __APP_GIT_BRANCH__ !== 'undefined' ? String(__APP_GIT_BRANCH__) : ''

  const candidateRoots = [
    resolve(__dirname, '../../../../'),
    resolve(process.cwd()),
  ]

  for (const repoRoot of candidateRoots) {
    try {
      const sha = injectedSha || execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf-8' }).trim()
      const branch = injectedBranch || execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], { encoding: 'utf-8' }).trim() || execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()
      return {
        sha: sha || injectedSha || 'unknown',
        branch: branch === 'HEAD' ? '' : branch,
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return {
    sha: injectedSha || 'unknown',
    branch: injectedBranch,
  }
}

const PACKAGE_INFO = readPackageInfo()
const LOCAL_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : PACKAGE_INFO?.version || ''
const BUILD_INFO = readBuildInfo()

let cachedLatestVersion = ''

export async function checkLatestVersion(): Promise<void> {
  try {
    const packageName = PACKAGE_INFO?.name || 'hermes-web-ui'
    const registryName = encodeURIComponent(packageName)
    const res = await fetch(`https://registry.npmjs.org/${registryName}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.ok) {
      const data = await res.json() as { version: string }
      cachedLatestVersion = data.version
      if (LOCAL_VERSION && cachedLatestVersion !== LOCAL_VERSION) {
        console.log(`Update available: ${LOCAL_VERSION} → ${cachedLatestVersion}`)
      }
    }
  } catch { /* ignore */ }
}

export function startVersionCheck(): void {
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  ctx.body = {
    status: 'ok',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: 'running',
    webui_version: LOCAL_VERSION,
    webui_git_sha: BUILD_INFO.sha,
    webui_git_branch: BUILD_INFO.branch,
    webui_latest: cachedLatestVersion,
    webui_update_available: Boolean(LOCAL_VERSION && cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION),
    node_version: process.versions.node,
  }
}
