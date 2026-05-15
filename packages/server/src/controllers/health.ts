import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'
import { getGatewayManagerInstance } from '../services/gateway-bootstrap'
import { config } from '../config'

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

function isUpdateConfigured(): boolean {
  return Boolean(config.update.enabled && config.update.packageName && config.update.registry)
}

export async function checkLatestVersion(): Promise<void> {
  if (!isUpdateConfigured()) {
    cachedLatestVersion = ''
    return
  }

  try {
    const packageName = config.update.packageName
    const registryName = encodeURIComponent(packageName)
    const res = await fetch(`${config.update.registry}/${registryName}/latest`, { signal: AbortSignal.timeout(10000) })
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
  if (!isUpdateConfigured()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  let gatewayOk = false
  try {
    const mgr = getGatewayManagerInstance()
    const upstream = mgr?.getUpstream()
    if (!upstream) {
      throw new Error('GatewayManager not initialized')
    }
    const res = await fetch(`${upstream.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) })
    gatewayOk = res.ok
  } catch { }
  ctx.body = {
    status: gatewayOk ? 'ok' : 'error',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: gatewayOk ? 'running' : 'stopped',
    webui_version: LOCAL_VERSION,
    webui_latest: cachedLatestVersion,
    webui_update_enabled: isUpdateConfigured(),
    webui_update_source_label: config.update.sourceLabel,
    webui_update_available: Boolean(isUpdateConfigured() && LOCAL_VERSION && cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION),
    node_version: process.versions.node,
  }
}
