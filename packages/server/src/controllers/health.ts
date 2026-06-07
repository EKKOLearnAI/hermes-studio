import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'
import { getAgentBridgeManager } from '../services/hermes/agent-bridge/manager'

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

export async function checkLatestVersion(): Promise<void> {
  if (isUpdateCheckDisabled()) return
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
  if (isUpdateCheckDisabled()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

async function getAgentBridgeHealth() {
  const manager = getAgentBridgeManager()
  const endpoint = typeof manager.getRuntimeState === 'function'
    ? manager.getRuntimeState().endpoint
    : undefined

  try {
    const readiness = await manager.checkReadiness({ timeoutMs: 750, connectRetryMs: 0 })
    const error = redactAgentBridgeError(readiness.error, readiness.endpoint)
    return {
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
      error,
    }
  } catch (err) {
    return {
      status: 'unknown',
      reachable: false,
      error: redactAgentBridgeError(err instanceof Error ? err.message : String(err), endpoint),
    }
  }
}

function redactAgentBridgeError(error: string | undefined, endpoint?: string): string | undefined {
  if (!error) return undefined
  if (!endpoint) return error

  const candidates = [endpoint]

  if (endpoint.startsWith('ipc://')) {
    candidates.push(endpoint.slice('ipc://'.length))
  }

  if (endpoint.startsWith('tcp://')) {
    try {
      const url = new URL(endpoint)
      candidates.push(url.host)
    } catch {
      // Ignore malformed endpoints and fall back to the original string.
    }
  }

  return candidates
    .filter(candidate => candidate)
    .reduce((message, candidate) => message.split(candidate).join('[redacted endpoint]'), error)
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  const agentBridge = await getAgentBridgeHealth()
  ctx.body = {
    status: 'ok',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: 'running',
    webui_version: LOCAL_VERSION,
    webui_latest: isUpdateCheckDisabled() ? '' : cachedLatestVersion,
    webui_update_available: isUpdateCheckDisabled()
      ? false
      : Boolean(LOCAL_VERSION && cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION),
    node_version: process.versions.node,
    agent_bridge: agentBridge,
  }
}
