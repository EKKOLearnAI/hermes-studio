#!/usr/bin/env node
// Install hermes-agent into the bundled Python at resources/python/<os>-<arch>/.
// Prefers `uv` (10-100x faster, more deterministic) and falls back to pip.
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { platform as osPlatform, arch as osArch } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const HERMES_VERSION = process.env.HERMES_VERSION || '0.15.2'
const HERMES_PACKAGE = process.env.HERMES_PACKAGE || `hermes-agent[mcp]==${HERMES_VERSION}`

const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)

const pyBin = TARGET_OS === 'win32'
  ? resolve(PY_DIR, 'python.exe')
  : resolve(PY_DIR, 'bin', 'python3')

if (!existsSync(pyBin)) {
  console.error(`Python not found at ${pyBin}. Run: npm run fetch:python`)
  process.exit(1)
}

function hasUv() {
  const r = spawnSync('uv', ['--version'], { stdio: 'ignore' })
  return r.status === 0
}

let r
if (hasUv()) {
  console.log(`→ Installing ${HERMES_PACKAGE} via uv`)
  r = spawnSync('uv', [
    'pip', 'install',
    '--python', pyBin,
    HERMES_PACKAGE,
  ], { stdio: 'inherit' })
} else {
  console.log(`→ Installing ${HERMES_PACKAGE} via pip`)
  r = spawnSync(pyBin, [
    '-m', 'pip', 'install',
    HERMES_PACKAGE,
    '--no-warn-script-location',
    '--disable-pip-version-check',
  ], { stdio: 'inherit' })
}
if (r.status !== 0) process.exit(r.status ?? 1)

r = spawnSync(pyBin, [
  '-c',
  'import mcp; import tools.mcp_tool as t; assert t._MCP_AVAILABLE',
], { stdio: 'inherit' })
if (r.status !== 0) {
  console.error('MCP Python SDK sanity check failed')
  process.exit(r.status ?? 1)
}

const hermesBin = TARGET_OS === 'win32'
  ? resolve(PY_DIR, 'Scripts', 'hermes.exe')
  : resolve(PY_DIR, 'bin', 'hermes')
const hermesCheckCommand = TARGET_OS === 'win32' ? pyBin : hermesBin
const hermesCheckArgs = TARGET_OS === 'win32' ? ['-m', 'hermes_cli.main', '--version'] : ['--version']

if (!existsSync(hermesBin)) {
  console.error(`hermes binary not found at ${hermesBin} after install`)
  process.exit(1)
}

// hermes-web-ui's agent-bridge searches for `run_agent.py` at <python_root>/run_agent.py
// (and a few neighbouring dirs). pip places it at site-packages/run_agent.py — surface
// it at the venv root with a *relative* symlink so the venv stays portable when copied
// into the packaged .app/.exe (an absolute symlink would break the moment the bundle
// is moved to /Applications/...).
const { readdirSync, symlinkSync, copyFileSync, unlinkSync, lstatSync } = await import('node:fs')
function siteRunAgentRelative() {
  if (TARGET_OS === 'win32') {
    return ['Lib', 'site-packages', 'run_agent.py'].join('\\')
  }
  const libDir = resolve(PY_DIR, 'lib')
  const py = readdirSync(libDir).find(n => /^python\d+\.\d+$/.test(n))
  return ['lib', py, 'site-packages', 'run_agent.py'].join('/')
}
{
  const relSrc = siteRunAgentRelative()
  const absSrc = resolve(PY_DIR, relSrc)
  const dst = resolve(PY_DIR, 'run_agent.py')
  if (existsSync(absSrc)) {
    try { lstatSync(dst); unlinkSync(dst) } catch {}
    if (TARGET_OS === 'win32') copyFileSync(absSrc, dst)
    else symlinkSync(relSrc, dst)
    console.log(`✓ run_agent.py linked at venv root (relative → ${relSrc})`)
  } else {
    console.warn(`! run_agent.py not found at ${absSrc} — agent-bridge may fail`)
  }
}

// Relocate: replace the pip-generated launcher (which embeds an absolute
// shebang to the build-time Python path) with a relative wrapper so the
// bundled venv works after being moved into the .app/.exe payload.
const { writeFileSync, chmodSync } = await import('node:fs')
if (TARGET_OS === 'win32') {
  // Windows: pip generates a .exe launcher that embeds a relative shebang
  // already. Add a .cmd wrapper that prefers the colocated python.exe.
  const cmdPath = resolve(PY_DIR, 'Scripts', 'hermes.cmd')
  writeFileSync(
    cmdPath,
    [
      '@echo off',
      'set "PY=%~dp0..\\python.exe"',
      '"%PY%" -m hermes_cli.main %*',
    ].join('\r\n'),
  )
} else {
  const launcher = [
    '#!/bin/sh',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'exec "$DIR/python3" -m hermes_cli.main "$@"',
    '',
  ].join('\n')
  writeFileSync(hermesBin, launcher, { mode: 0o755 })
  chmodSync(hermesBin, 0o755)
  // Same for hermes-agent / hermes-acp (they all just dispatch into modules)
  for (const [name, mod] of [
    ['hermes-agent', 'run_agent'],
    ['hermes-acp', 'acp_adapter.entry'],
  ]) {
    const p = resolve(PY_DIR, 'bin', name)
    if (existsSync(p)) {
      writeFileSync(p, launcher.replace('hermes_cli.main', mod), { mode: 0o755 })
      chmodSync(p, 0o755)
    }
  }
}

console.log(`✓ hermes installed at ${hermesBin} (relocatable launcher)`)

r = spawnSync(hermesCheckCommand, hermesCheckArgs, { stdio: 'inherit' })
if (r.status !== 0) {
  console.error('hermes --version failed')
  process.exit(r.status ?? 1)
}
