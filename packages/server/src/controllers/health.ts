import * as hermesCli from '../services/hermes/hermes-cli'
import { getGatewayManagerInstance } from '../services/gateway-bootstrap'
import { config } from '../config'

declare const __APP_VERSION__: string
const LOCAL_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { const { readFileSync } = require('fs'); const { resolve } = require('path'); return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return '0.0.0' } })()

let cachedLatestVersion = ''

export async function checkLatestVersion(): Promise<void> {
  try {
    const { readFileSync } = require('fs')
    const pkg = JSON.parse(readFileSync(resolve(require('path').join(__dirname, '../../package.json')), 'utf-8'))
    const name = pkg.name
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.ok) {
      const data = await res.json() as { version: string }
      cachedLatestVersion = data.version
      if (cachedLatestVersion !== LOCAL_VERSION) {
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
  let gatewayOk = false
  try {
    const mgr = getGatewayManagerInstance()
    const upstream = mgr?.getUpstream() || config.upstream
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
    webui_update_available: cachedLatestVersion && cachedLatestVersion !== LOCAL_VERSION,
    node_version: process.versions.node,
  }
}

function resolve(p: string) { return p }
