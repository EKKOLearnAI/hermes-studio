import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'
import { config } from '../config'

declare const __APP_VERSION__: string

const BUILD_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : ''

let cachedLatestVersion = ''

interface PackageInfo {
  name: string
  version: string
}

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    resolve(__dirname, '../../package.json'),
    resolve(__dirname, '../../../../package.json'),
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
    } catch {}
  }
  return null
}

const PACKAGE_INFO = readPackageInfo()
const LOCAL_VERSION = BUILD_VERSION || PACKAGE_INFO?.version || ''

function hasConfiguredUpdateSource(): boolean {
  return Boolean(config.update.enabled && config.update.packageName && config.update.registry && config.update.cliBin)
}

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
  if (hasConfiguredUpdateSource()) return false
  const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
}

export async function checkLatestVersion(): Promise<void> {
  if (!hasConfiguredUpdateSource()) return
  try {
    const packageName = config.update.packageName || PACKAGE_INFO?.name || 'hermes-web-ui'
    const registry = config.update.registry || 'https://registry.npmjs.org'
    const distTag = config.update.distTag || 'latest'
    const registryName = encodeURIComponent(packageName)
    const url = `${registry}/${registryName}`

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (res.ok) {
      const data = await res.json() as { version: string; 'dist-tags'?: Record<string, string> }
      const version = data['dist-tags']?.[distTag] || data.version || data['dist-tags']?.latest
      if (version) {
        cachedLatestVersion = version
        if (LOCAL_VERSION && cachedLatestVersion !== LOCAL_VERSION) {
          console.log(`Update available: ${LOCAL_VERSION} → ${cachedLatestVersion}`)
        }
      }
    }
  } catch { /* ignore */ }
}

export function startVersionCheck(): void {
  if (!hasConfiguredUpdateSource() || isUpdateCheckDisabled()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  const updateEnabled = hasConfiguredUpdateSource()
  const updateCheckDisabled = isUpdateCheckDisabled()
  ctx.body = {
    status: 'ok',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: 'running',
    webui_version: LOCAL_VERSION,
    webui_latest: updateCheckDisabled ? '' : cachedLatestVersion,
    webui_update_enabled: updateEnabled,
    webui_update_source_label: updateEnabled ? config.update.sourceLabel : '',
    webui_update_available: updateCheckDisabled
      ? false
      : Boolean(LOCAL_VERSION && cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION),
    node_version: process.versions.node,
  }
}
