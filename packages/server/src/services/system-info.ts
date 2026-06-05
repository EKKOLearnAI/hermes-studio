import { arch, hostname, platform, release, type } from 'os'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as hermesCli from './hermes/hermes-cli'

declare const __APP_VERSION__: string

type PackageInfo = {
  version: string
}

export type PublicSystemInfo = {
  computer_name: string
  os: {
    type: string
    platform: NodeJS.Platform
    release: string
    arch: string
  }
  hermes_agent_version: string
  hermes_web_ui_version: string
}

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    // ts-node dev: packages/server/src/services -> repo root
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
      if (pkg?.version) return { version: String(pkg.version) }
    } catch {
      // Try the next candidate path.
    }
  }

  return null
}

export function getHermesWebUiVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : readPackageInfo()?.version || ''
}

export function normalizeHermesAgentVersion(raw: string): string {
  return raw.split('\n')[0]?.replace(/^Hermes Agent\s+/, '').trim() || ''
}

export async function getPublicSystemInfo(): Promise<PublicSystemInfo> {
  const hermesAgentVersion = normalizeHermesAgentVersion(await hermesCli.getVersion())

  return {
    computer_name: hostname(),
    os: {
      type: type(),
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    hermes_agent_version: hermesAgentVersion,
    hermes_web_ui_version: getHermesWebUiVersion(),
  }
}
