import * as hermesCli from '../services/hermes/hermes-cli'

declare const __APP_VERSION__: string

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
  // Auto-update checks are intentionally disabled for the branded distribution.
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
    webui_latest: cachedLatestVersion,
    webui_update_enabled: isUpdateConfigured(),
    webui_update_source_label: config.update.sourceLabel,
    webui_update_available: Boolean(isUpdateConfigured() && LOCAL_VERSION && cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION),
    node_version: process.versions.node,
  }
}
