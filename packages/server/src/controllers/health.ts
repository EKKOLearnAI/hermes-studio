import * as hermesCli from '../services/hermes/hermes-cli'

declare const __APP_VERSION__: string

const LOCAL_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : ''

export async function checkLatestVersion(): Promise<void> {
  return Promise.resolve()
}

export function startVersionCheck(): void {
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
    webui_latest: '',
    webui_update_enabled: false,
    webui_update_source_label: '',
    webui_update_available: false,
    node_version: process.versions.node,
  }
}
