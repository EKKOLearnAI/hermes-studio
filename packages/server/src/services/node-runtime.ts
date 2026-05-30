import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { delimiter, dirname, join, resolve } from 'path'
import { getWebUiHome } from '../config'

let nodeShimDir: string | null = null

export function isDesktopRuntime(): boolean {
  return process.env.HERMES_DESKTOP === 'true'
}

export function getNodeBinDir(): string {
  return dirname(process.execPath)
}

function getNodePrefix(): string {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getHomebrewPrefix(): string | null {
  const match = process.execPath.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/)
  return match?.[1] || null
}

function getBundledNpmCliCandidates(): string[] {
  return [
    // Bundled server: <webui>/dist/server/index.js -> <webui>/node_modules/npm/...
    resolve(__dirname, '../../node_modules/npm/bin/npm-cli.js'),
    // ts-node/dev server: packages/server/src/services -> repo root/node_modules/npm/...
    resolve(__dirname, '../../../../node_modules/npm/bin/npm-cli.js'),
    resolve(process.cwd(), 'node_modules/npm/bin/npm-cli.js'),
  ]
}

export function getNpmCliCandidates(): string[] {
  const prefix = getNodePrefix()
  const homebrewPrefix = getHomebrewPrefix()

  const runtimeCandidates = process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix ? [join(homebrewPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
      ]

  return [...getBundledNpmCliCandidates(), ...runtimeCandidates]
}

export function getNpmCliPath(): string | null {
  return getNpmCliCandidates().find(existsSync) || null
}

export function getNpmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function desktopNodeShimName(): string {
  return process.platform === 'win32' ? 'node.cmd' : 'node'
}

export function getDesktopNodeShimDir(): string {
  if (!isDesktopRuntime()) return ''
  if (nodeShimDir) return nodeShimDir

  const binDir = join(getWebUiHome(), 'node-runtime', 'bin')
  mkdirSync(binDir, { recursive: true })

  const shimPath = join(binDir, desktopNodeShimName())
  if (process.platform === 'win32') {
    writeFileSync(
      shimPath,
      [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${process.execPath}" %*`,
        '',
      ].join('\r\n'),
      'utf-8',
    )
  } else {
    writeFileSync(
      shimPath,
      [
        '#!/bin/sh',
        'export ELECTRON_RUN_AS_NODE=1',
        `exec "${process.execPath.replace(/"/g, '\\"')}" "$@"`,
        '',
      ].join('\n'),
      'utf-8',
    )
    chmodSync(shimPath, 0o755)
  }

  nodeShimDir = binDir
  return binDir
}

export function getManagedNpmPrefix(): string {
  const configured = process.env.HERMES_WEB_UI_NPM_PREFIX?.trim()
  if (configured) return resolve(configured)
  return isDesktopRuntime() ? join(getWebUiHome(), 'node-tools') : ''
}

export function getManagedNpmBinDir(prefix = getManagedNpmPrefix()): string {
  if (!prefix) return ''
  return process.platform === 'win32' ? prefix : join(prefix, 'bin')
}

function commonSystemPathDirs(): string[] {
  if (process.platform === 'win32') return []
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
}

function uniquePathEntries(entries: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    if (!entry) continue
    for (const part of entry.split(delimiter).filter(Boolean)) {
      if (seen.has(part)) continue
      seen.add(part)
      out.push(part)
    }
  }
  return out
}

export function getCurrentNodeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const npmPrefix = getManagedNpmPrefix()
  const nodeShim = getDesktopNodeShimDir()
  const pathEntries = uniquePathEntries([
    nodeShim,
    getManagedNpmBinDir(npmPrefix),
    getNodeBinDir(),
    ...commonSystemPathDirs(),
    process.env.PATH,
    extra.PATH,
  ])

  return {
    ...process.env,
    ...extra,
    PATH: pathEntries.join(delimiter),
    npm_node_execpath: process.execPath,
    ...(npmPrefix ? {
      npm_config_prefix: npmPrefix,
      NPM_CONFIG_PREFIX: npmPrefix,
    } : {}),
  }
}

export function getNpmExecution(args: string[]): { command: string; args: string[] } {
  const npmCli = getNpmCliPath()
  return npmCli
    ? { command: process.execPath, args: [npmCli, ...args] }
    : { command: getNpmBin(), args }
}
