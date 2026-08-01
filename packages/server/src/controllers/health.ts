import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'
import { getAgentBridgeManager } from '../services/hermes/agent-bridge/manager'
import { redactAgentBridgeError } from '../services/hermes/agent-bridge/redact'
import { isDockerContainer } from '../services/runtime-environment'

declare const __APP_VERSION__: string

type PackageInfo = {
  name: string
  version: string
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

const PACKAGE_INFO = readPackageInfo()
const LOCAL_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : PACKAGE_INFO?.version || ''

let cachedLatestVersion = ''
let cachedGitRemoteVersion = ''
const AGENT_BRIDGE_HEALTH_CACHE_TTL_MS = 250
const AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS = 75

/**
 * Detect whether the Web UI is running from a git clone (rather than an npm
 * global install or Docker image). In a git-clone deployment the repo root
 * contains a .git directory and the server is started from the built dist/
 * output. This deployment type cannot use `npm install -g` to upgrade —
 * it needs `git pull && npm install && npm run build` instead.
 */
function detectGitCloneDeployment(): boolean {
  // Docker containers are never considered git-clone deployments
  if (isDockerContainer()) return false

  const candidatePaths = [
    resolve(__dirname, '../../../../.git'),
    resolve(__dirname, '../../.git'),
    resolve(process.cwd(), '.git'),
  ]

  return candidatePaths.some(p => existsSync(p))
}

let isGitCloneDeploy: boolean | null = null
function isGitCloneDeployment(): boolean {
  if (isGitCloneDeploy === null) {
    isGitCloneDeploy = detectGitCloneDeployment()
  }
  return isGitCloneDeploy
}

/**
 * Get the repo root for a git-clone deployment.
 */
function getGitRepoRoot(): string | null {
  const candidatePaths = [
    resolve(__dirname, '../../../..'),
    resolve(__dirname, '../..'),
    process.cwd(),
  ]

  for (const p of candidatePaths) {
    if (existsSync(resolve(p, '.git')) && existsSync(resolve(p, 'package.json'))) {
      return p
    }
  }
  return null
}

/**
 * Check for updates in a git-clone deployment by fetching from origin and
 * comparing the local HEAD with origin/main.
 */
async function checkGitLatestVersion(): Promise<void> {
  const repoRoot = getGitRepoRoot()
  if (!repoRoot) return

  try {
    // Fetch origin to get latest remote refs
    execFileSync('git', ['fetch', 'origin', 'main'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Get remote HEAD version by reading package.json from origin/main
    const remotePackageJson = execFileSync('git', ['show', 'origin/main:package.json'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const remotePkg = JSON.parse(remotePackageJson)
    if (remotePkg?.version) {
      cachedGitRemoteVersion = String(remotePkg.version)
      if (LOCAL_VERSION && isNewerVersion(cachedGitRemoteVersion, LOCAL_VERSION)) {
        console.log(`Git update available: ${LOCAL_VERSION} -> ${cachedGitRemoteVersion}`)
      }
    }
  } catch {
    // Ignore — git may not be available or repo may not have a remote
  }
}

type AgentBridgeHealthPayload = {
  status: string
  reachable: boolean
  ready?: boolean
  running?: boolean
  attached?: boolean
  starting?: boolean
  stopping?: boolean
  restart_scheduled?: boolean
  restart_attempts?: number
  endpoint_kind?: 'ipc' | 'tcp' | 'unknown'
  pid?: number
  error?: string
}

let cachedAgentBridgeHealth: { value: AgentBridgeHealthPayload; expiresAt: number } | null = null
let pendingAgentBridgeHealthRefresh: Promise<AgentBridgeHealthPayload> | null = null

/**
 * Whether the periodic npm-registry version check is disabled.
 *
 * Useful when hermes-web-ui is bundled inside a packaged distribution
 * (e.g. a desktop app) where the user can't `npm install -g hermes-web-ui@latest`
 * to upgrade — the "update available" prompt would be misleading and
 * the periodic outbound HTTP request to the npm registry is unnecessary.
 *
 * Set HERMES_WEB_UI_DISABLE_UPDATE_CHECK=true (or 1, on, yes) to disable.
 */
function isUpdateCheckDisabled(): boolean {
  const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
}

function compareVersions(left: string, right: string): number {
  const normalize = (value: string) => value.trim().replace(/^v/i, '').split(/[.-]/)
  const leftParts = normalize(left)
  const rightParts = normalize(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || '0'
    const rightPart = rightParts[index] || '0'
    const leftNumber = Number.parseInt(leftPart, 10)
    const rightNumber = Number.parseInt(rightPart, 10)
    const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    const diff = numeric ? leftNumber - rightNumber : leftPart.localeCompare(rightPart, undefined, { numeric: true })
    if (diff !== 0) return diff
  }
  return 0
}

function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export async function checkLatestVersion(): Promise<void> {
  if (isUpdateCheckDisabled()) return

  // For git-clone deployments, check via git fetch instead of npm registry
  if (isGitCloneDeployment()) {
    await checkGitLatestVersion()
    return
  }

  try {
    const packageName = PACKAGE_INFO?.name || 'hermes-web-ui'
    const registryName = encodeURIComponent(packageName)
    const res = await fetch(`https://registry.npmjs.org/${registryName}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.ok) {
      const data = await res.json() as { version: string }
      cachedLatestVersion = data.version
      if (LOCAL_VERSION && cachedLatestVersion && isNewerVersion(cachedLatestVersion, LOCAL_VERSION)) {
        console.log(`Update available: ${LOCAL_VERSION} -> ${cachedLatestVersion}`)
      }
    }
  } catch { /* ignore */ }
}

export function startVersionCheck(): void {
  if (isUpdateCheckDisabled()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

async function getAgentBridgeHealth() {
  const now = Date.now()
  if (cachedAgentBridgeHealth && cachedAgentBridgeHealth.expiresAt > now) {
    return cachedAgentBridgeHealth.value
  }

  if (!pendingAgentBridgeHealthRefresh) {
    pendingAgentBridgeHealthRefresh = refreshAgentBridgeHealth().finally(() => {
      pendingAgentBridgeHealthRefresh = null
    })
  }

  if (cachedAgentBridgeHealth) {
    return cachedAgentBridgeHealth.value
  }

  const firstResult = await Promise.race([
    pendingAgentBridgeHealthRefresh,
    new Promise<AgentBridgeHealthPayload>((resolve) => {
      setTimeout(() => resolve({ status: 'unknown', reachable: false }), AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS)
    }),
  ])

  return firstResult
}

async function refreshAgentBridgeHealth(): Promise<AgentBridgeHealthPayload> {
  let endpoint: string | undefined

  try {
    const manager = getAgentBridgeManager()
    endpoint = typeof manager.getRuntimeState === 'function'
      ? manager.getRuntimeState().endpoint
      : undefined

    const readiness = await manager.checkReadiness({ timeoutMs: AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS, connectRetryMs: 0 })
    const value: AgentBridgeHealthPayload = {
      status: readiness.status,
      reachable: readiness.reachable,
      ready: readiness.ready,
      running: readiness.running,
      attached: readiness.attached,
      starting: readiness.starting,
      stopping: readiness.stopping,
      restart_scheduled: readiness.restartScheduled,
      restart_attempts: readiness.restartAttempts,
      endpoint_kind: readiness.endpointKind,
      pid: readiness.pid,
      error: redactAgentBridgeError(readiness.error, readiness.endpoint),
    }
    cachedAgentBridgeHealth = { value, expiresAt: Date.now() + AGENT_BRIDGE_HEALTH_CACHE_TTL_MS }
    return value
  } catch (err) {
    const value: AgentBridgeHealthPayload = {
      status: 'unknown',
      reachable: false,
      error: redactAgentBridgeError(err instanceof Error ? err.message : String(err), endpoint),
    }
    cachedAgentBridgeHealth = { value, expiresAt: Date.now() + AGENT_BRIDGE_HEALTH_CACHE_TTL_MS }
    return value
  }
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  const agentBridge = await getAgentBridgeHealth()

  const gitDeploy = isGitCloneDeployment()
  const latestVersion = gitDeploy ? cachedGitRemoteVersion : (isUpdateCheckDisabled() ? '' : cachedLatestVersion)
  const updateAvailable = isUpdateCheckDisabled()
    ? false
    : Boolean(LOCAL_VERSION && latestVersion && isNewerVersion(latestVersion, LOCAL_VERSION))

  ctx.body = {
    status: 'ok',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: 'running',
    webui_version: LOCAL_VERSION,
    webui_latest: latestVersion,
    webui_update_available: updateAvailable,
    node_version: process.versions.node,
    agent_bridge: agentBridge,
    is_docker: isDockerContainer(),
    is_git_clone: gitDeploy,
  }
}
