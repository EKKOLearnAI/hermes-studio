import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export type RuntimeRelocationRepair = {
  editableFilesRewritten: number
  launchersRewritten: number
}

function sitePackagesDirectories(sourceRoot: string, platform: NodeJS.Platform): string[] {
  const venvRoot = join(sourceRoot, 'venv')
  if (platform === 'win32') {
    const sitePackages = join(venvRoot, 'Lib', 'site-packages')
    return existsSync(sitePackages) ? [sitePackages] : []
  }

  const libRoot = join(venvRoot, 'lib')
  if (!existsSync(libRoot)) return []
  return readdirSync(libRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name))
    .map(entry => join(libRoot, entry.name, 'site-packages'))
    .filter(existsSync)
}

function pathReplacementPairs(previousPath: string, finalPath: string): Array<[string, string]> {
  const previous = resolve(previousPath)
  const final = resolve(finalPath)
  const pairs: Array<[string, string]> = [
    [pathToFileURL(previous).href, pathToFileURL(final).href],
    [previous, final],
    [previous.split(sep).join('/'), final.split(sep).join('/')],
  ]
  if (previous.includes('\\') || final.includes('\\')) {
    pairs.push([
      previous.replace(/\\/g, '\\\\'),
      final.replace(/\\/g, '\\\\'),
    ])
  }
  return Array.from(new Map(pairs.filter(([from]) => from).map(pair => [pair[0], pair])).values())
    .sort((left, right) => right[0].length - left[0].length)
}

function rewriteTextFile(file: string, replacements: Array<[string, string]>): boolean {
  const original = readFileSync(file, 'utf-8')
  let updated = original
  for (const [from, to] of replacements) {
    updated = updated.split(from).join(to)
  }
  if (updated === original) return false
  writeFileSync(file, updated)
  return true
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function windowsVenvHomeIsValid(config: string, sourceRoot: string): boolean {
  const homeLine = config
    .split(/\r?\n/)
    .find(line => /^\s*home\s*=/.test(line))
  const configuredHome = homeLine
    ? homeLine.replace(/^\s*home\s*=\s*/, '').trim()
    : ''
  return Boolean(
    configuredHome
    && isAbsolute(configuredHome)
    && isSameOrNestedPath(sourceRoot, configuredHome),
  )
}

export function windowsRuntimeNeedsRelocationRepair(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false

  const sourceRoot = join(runtimeRoot, 'python')
  const venvRoot = join(sourceRoot, 'venv')
  if (!existsSync(venvRoot)) return false

  const pyvenvConfig = join(venvRoot, 'pyvenv.cfg')
  if (existsSync(pyvenvConfig)) {
    try {
      if (!windowsVenvHomeIsValid(readFileSync(pyvenvConfig, 'utf-8'), sourceRoot)) {
        return true
      }
    } catch {
      return true
    }
  }

  const scriptsRoot = join(venvRoot, 'Scripts')
  return ['hermes', 'hermes-agent', 'hermes-acp'].some(name =>
    existsSync(join(scriptsRoot, `${name}.exe`))
    && !existsSync(join(scriptsRoot, `${name}.cmd`)),
  )
}

function rewriteWindowsVenvConfig(
  file: string,
  previousSourceRoot: string,
  finalSourceRoot: string,
): boolean {
  const original = readFileSync(file, 'utf-8')
  let updated = original
  for (const [from, to] of pathReplacementPairs(previousSourceRoot, finalSourceRoot)) {
    updated = updated.split(from).join(to)
  }

  const lines = updated.split(/\r?\n/)
  const homeIndex = lines.findIndex(line => /^\s*home\s*=/.test(line))
  const configuredHome = homeIndex >= 0
    ? lines[homeIndex].replace(/^\s*home\s*=\s*/, '').trim()
    : ''
  const home = windowsVenvHomeIsValid(updated, finalSourceRoot)
    ? configuredHome
    : join(finalSourceRoot, 'base')
  if (homeIndex >= 0) {
    lines[homeIndex] = `home = ${home}`
  } else {
    lines.unshift(`home = ${home}`)
  }

  updated = lines.join('\r\n').replace(/(?:\r?\n)*$/, '\r\n')
  if (updated === original) return false
  writeFileSync(file, updated)
  return true
}

function rewriteEditableReferences(
  stagedSourceRoot: string,
  previousSourceRoot: string,
  finalSourceRoot: string,
  platform: NodeJS.Platform,
): number {
  const replacements = pathReplacementPairs(previousSourceRoot, finalSourceRoot)
  let rewritten = 0

  const pyvenvConfig = join(stagedSourceRoot, 'venv', 'pyvenv.cfg')
  if (existsSync(pyvenvConfig)) {
    if (platform === 'win32') {
      if (rewriteWindowsVenvConfig(
        pyvenvConfig,
        previousSourceRoot,
        finalSourceRoot,
      )) rewritten += 1
    } else if (rewriteTextFile(pyvenvConfig, replacements)) {
      rewritten += 1
    }
  }

  for (const sitePackages of sitePackagesDirectories(stagedSourceRoot, platform)) {
    for (const entry of readdirSync(sitePackages, { withFileTypes: true })) {
      if (entry.isFile()
        && entry.name.startsWith('__editable__')
        && (entry.name.endsWith('.pth') || entry.name.endsWith('.py'))
        && rewriteTextFile(join(sitePackages, entry.name), replacements)) {
        rewritten += 1
      }
      if (!entry.isDirectory() || !/^hermes_agent-.*\.dist-info$/.test(entry.name)) continue
      const directUrl = join(sitePackages, entry.name, 'direct_url.json')
      if (existsSync(directUrl) && rewriteTextFile(directUrl, replacements)) rewritten += 1
    }
  }

  return rewritten
}

function rewriteHermesLaunchers(sourceRoot: string, platform: NodeJS.Platform): number {
  const venvRoot = join(sourceRoot, 'venv')
  const modules: Array<[string, string]> = [
    ['hermes', 'hermes_cli.main'],
    ['hermes-agent', 'run_agent'],
    ['hermes-acp', 'acp_adapter.entry'],
  ]
  let rewritten = 0

  if (platform === 'win32') {
    const scriptsRoot = join(venvRoot, 'Scripts')
    if (!existsSync(scriptsRoot)) return 0
    for (const [name, module] of modules) {
      const cmd = join(scriptsRoot, `${name}.cmd`)
      const executable = join(scriptsRoot, `${name}.exe`)
      if (!existsSync(cmd) && !existsSync(executable)) continue
      writeFileSync(cmd, [
        '@echo off',
        'set "PY=%~dp0python.exe"',
        'set "VIRTUAL_ENV=%~dp0.."',
        'set "UV_PROJECT_ENVIRONMENT=%VIRTUAL_ENV%"',
        'set "UV_PYTHON=%PY%"',
        `"%PY%" -m ${module} %*`,
        '',
      ].join('\r\n'))
      rmSync(executable, { force: true })
      rewritten += 1
    }
    return rewritten
  }

  const binRoot = join(venvRoot, 'bin')
  if (!existsSync(binRoot)) return 0
  for (const [name, module] of modules) {
    const launcher = join(binRoot, name)
    if (!existsSync(launcher)) continue
    writeFileSync(launcher, [
      '#!/bin/sh',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'VIRTUAL_ENV="$(cd "$DIR/.." && pwd)"',
      'export VIRTUAL_ENV',
      'export UV_PROJECT_ENVIRONMENT="$VIRTUAL_ENV"',
      'export UV_PYTHON="$DIR/python3"',
      'export UV_SYSTEM_PYTHON=1',
      `exec "$DIR/python3" -m ${module} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
    chmodSync(launcher, 0o755)
    rewritten += 1
  }
  return rewritten
}

/**
 * Repair paths generated by a user-run `hermes update` before a copied runtime
 * is moved into its final storage directory. Initial release archives already
 * use relative Python-home/editable paths and launchers; this handles later
 * upstream uv/pip installs, which may record the runtime's previous absolute
 * directory.
 */
export function repairMovedHermesRuntime(
  stagedRuntime: string,
  previousRuntime: string,
  finalRuntime: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeRelocationRepair {
  const stagedSourceRoot = join(stagedRuntime, 'python')
  const stagedVenv = join(stagedSourceRoot, 'venv')
  if (!existsSync(stagedVenv)) {
    return { editableFilesRewritten: 0, launchersRewritten: 0 }
  }

  const editableFilesRewritten = rewriteEditableReferences(
    stagedSourceRoot,
    join(previousRuntime, 'python'),
    join(finalRuntime, 'python'),
    platform,
  )
  const launchersRewritten = rewriteHermesLaunchers(stagedSourceRoot, platform)
  return { editableFilesRewritten, launchersRewritten }
}
