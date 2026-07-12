#!/usr/bin/env node
// Install hermes-agent into the bundled Python at resources/python/<os>-<arch>/.
// Prefers `uv` (10-100x faster, more deterministic) and falls back to pip.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { platform as osPlatform, arch as osArch, homedir as osHomedir, tmpdir } from 'node:os'
import { hermesVersion } from './runtime-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const HERMES_VERSION = hermesVersion()
// Match the packaged runtime to the channel list exposed at /hermes/channels.
// Telegram, Discord, and Slack are covered by "messaging". We intentionally
// install Matrix's plaintext deps below instead of using the "matrix" extra:
// that extra pulls mautrix[encryption] -> python-olm, which needs a fragile
// native build on desktop packaging machines. WhatsApp, QQBot, and Weixin do
// not expose dedicated hermes-agent extras; their deps are covered by base or
// the channel extras below.
const HERMES_EXTRAS = [
  'mcp',
  'messaging',
  'slack',
  'wecom',
  'dingtalk',
  'feishu',
].join(',')
const HERMES_PACKAGE = process.env.HERMES_PACKAGE || `hermes-agent[${HERMES_EXTRAS}]==${HERMES_VERSION}`
const EXTRA_PYTHON_PACKAGES = splitPackageList(
  process.env.HERMES_EXTRA_PYTHON_PACKAGES || [
    'websockets',
    'mautrix==0.21.0',
    'Markdown==3.10.2',
    'aiosqlite==0.22.1',
    'asyncpg==0.31.0',
    'aiohttp-socks==0.11.0',
  ].join(' '),
)
const BROWSER_PACKAGES = splitPackageList(
  process.env.HERMES_BROWSER_PACKAGES || 'agent-browser@^0.26.0 @askjo/camofox-browser@^1.5.2',
)
const CHROME_FOR_TESTING_VERSION = (
  process.env.HERMES_CHROME_FOR_TESTING_VERSION
  || process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_VERSION
  || '149.0.7827.55'
).trim()
const SKIP_BROWSER_RUNTIME = process.env.HERMES_SKIP_BROWSER_RUNTIME === '1'
  || process.env.HERMES_SKIP_BROWSER_RUNTIME?.toLowerCase() === 'true'

const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const PY_DIR = resolve(ROOT, 'resources', 'python', `${OS_LABEL}-${TARGET_ARCH}`)
const NODE_DIR = resolve(ROOT, 'resources', 'node', `${OS_LABEL}-${TARGET_ARCH}`)
const NODE_PREFIX = resolve(PY_DIR, 'node')
const AGENT_BROWSER_HOME = resolve(PY_DIR, 'agent-browser')
const PLAYWRIGHT_BROWSERS_PATH = resolve(PY_DIR, 'ms-playwright')

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

function splitPackageList(value) {
  return value
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function optionalRun(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', ...options })
}

function commandInvocation(command) {
  if (TARGET_OS === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    const cmdCommand = /[\s&()[\]{}^=;!'+,`~]/.test(command) ? `"${command}"` : command
    return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmdCommand] }
  }
  return { command, argsPrefix: [] }
}

function runInvocation(invocation, args, options = {}) {
  return run(invocation.command, [...invocation.argsPrefix, ...args], options)
}

function optionalRunInvocation(invocation, args, options = {}) {
  return optionalRun(invocation.command, [...invocation.argsPrefix, ...args], options)
}

function pythonBuildEnv() {
  if (TARGET_OS !== 'darwin') return process.env

  const env = { ...process.env }
  if (!env.AR && existsSync('/usr/bin/ar')) env.AR = '/usr/bin/ar'
  if (!env.RANLIB && existsSync('/usr/bin/ranlib')) env.RANLIB = '/usr/bin/ranlib'
  return env
}

function installPythonPackages(packages, label) {
  if (packages.length === 0) return
  const env = pythonBuildEnv()
  if (hasUv()) {
    console.log(`→ Installing ${label} via uv: ${packages.join(' ')}`)
    run('uv', [
      'pip', 'install',
      '--python', pyBin,
      ...packages,
    ], { env })
  } else {
    console.log(`→ Installing ${label} via pip: ${packages.join(' ')}`)
    run(pyBin, [
      '-m', 'pip', 'install',
      ...packages,
      '--no-warn-script-location',
      '--disable-pip-version-check',
    ], { env })
  }
}

function npmCommand() {
  const bundled = TARGET_OS === 'win32'
    ? resolve(NODE_DIR, 'npm.cmd')
    : resolve(NODE_DIR, 'bin', 'npm')
  const candidates = TARGET_OS === 'win32'
    ? [bundled, 'npm.cmd', 'npm.exe', 'npm']
    : [bundled, 'npm']
  for (const candidate of candidates) {
    if (candidate === bundled && !existsSync(candidate)) continue
    const invocation = commandInvocation(candidate)
    const result = optionalRunInvocation(invocation, ['--version'], { stdio: 'ignore', env: browserRuntimeEnv(false) })
    if (result.status === 0) return invocation
  }
  return null
}

function agentBrowserCommand() {
  if (TARGET_OS === 'win32') {
    return resolve(NODE_PREFIX, 'agent-browser.cmd')
  }
  return resolve(NODE_PREFIX, 'bin', 'agent-browser')
}

function browserRuntimeEnv(includeAgentBrowser = true) {
  const bundledNodeBin = TARGET_OS === 'win32'
    ? NODE_DIR
    : resolve(NODE_DIR, 'bin')
  const nodePath = TARGET_OS === 'win32'
    ? NODE_PREFIX
    : resolve(NODE_PREFIX, 'bin')
  const inheritedPath = process.env.PATH || process.env.Path || ''
  const pathKey = TARGET_OS === 'win32' ? 'Path' : 'PATH'
  const browserExecutable = includeAgentBrowser ? ensureBundledBrowserExecutable() : null
  const pathEntries = includeAgentBrowser
    ? [nodePath, bundledNodeBin, inheritedPath]
    : [bundledNodeBin, inheritedPath]
  const env = {
    ...process.env,
    [pathKey]: pathEntries.filter(Boolean).join(TARGET_OS === 'win32' ? ';' : ':'),
    HERMES_AGENT_NODE: TARGET_OS === 'win32' ? resolve(NODE_DIR, 'node.exe') : resolve(NODE_DIR, 'bin', 'node'),
    HERMES_AGENT_NODE_ROOT: NODE_DIR,
    AGENT_BROWSER_HOME,
    PLAYWRIGHT_BROWSERS_PATH,
  }
  if (browserExecutable) env.AGENT_BROWSER_EXECUTABLE_PATH = browserExecutable
  return env
}

function bundledBrowserExecutableNames() {
  if (TARGET_OS === 'win32') return new Set(['chrome.exe'])
  if (TARGET_OS === 'darwin') return new Set(['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chrome'])
  return new Set(['chrome', 'chromium', 'chromium-browser'])
}

function defaultAgentBrowserHomes() {
  const candidates = [
    process.env.USERPROFILE,
    process.env.UserProfile,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null,
    osHomedir(),
  ]
  return Array.from(new Set(
    candidates
      .map(home => home?.trim())
      .filter(Boolean)
      .map(home => resolve(home, '.agent-browser')),
  ))
}

function findBrowserInstallInHome(home) {
  const names = bundledBrowserExecutableNames()
  const browsersDir = join(home, 'browsers')
  const bundleDirs = []

  if (existsSync(browsersDir)) {
    try {
      for (const entry of readdirSync(browsersDir, { withFileTypes: true })) {
        if (entry.isDirectory()) bundleDirs.push(join(browsersDir, entry.name))
      }
    } catch {}
  }

  for (const bundleDir of bundleDirs) {
    const executable = findBrowserExecutableUnder(bundleDir, names)
    if (executable) return { executable, bundleDir }
  }

  return null
}

function findBrowserExecutableUnder(root, names) {
  const stack = [root].filter(existsSync)
  const visited = new Set()

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir || visited.has(dir)) continue
    visited.add(dir)

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && names.has(entry.name)) return path
      if (entry.isDirectory()) stack.push(path)
    }
  }

  return null
}

function findBundledBrowserExecutable() {
  return findBrowserInstallInHome(AGENT_BROWSER_HOME)?.executable ?? null
}

function shouldPinChromeForTesting() {
  if (!CHROME_FOR_TESTING_VERSION) return false
  return !['0', 'false', 'off', 'auto'].includes(CHROME_FOR_TESTING_VERSION.toLowerCase())
}

function chromeForTestingPlatform() {
  if (TARGET_OS === 'win32' && TARGET_ARCH === 'x64') return 'win64'
  if (TARGET_OS === 'darwin' && TARGET_ARCH === 'arm64') return 'mac-arm64'
  if (TARGET_OS === 'darwin' && TARGET_ARCH === 'x64') return 'mac-x64'
  if (TARGET_OS === 'linux' && TARGET_ARCH === 'x64') return 'linux64'
  throw new Error(`Pinned Chrome for Testing is not configured for ${TARGET_OS}-${TARGET_ARCH}`)
}

function chromeForTestingUrl() {
  if (process.env.HERMES_CHROME_FOR_TESTING_URL?.trim()) {
    return process.env.HERMES_CHROME_FOR_TESTING_URL.trim()
  }
  if (process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_URL?.trim()) {
    return process.env.HERMES_WINDOWS_CHROME_FOR_TESTING_URL.trim()
  }
  const platform = chromeForTestingPlatform()
  return `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/${platform}/chrome-${platform}.zip`
}

function removeChromeBundles() {
  const browsersDir = join(AGENT_BROWSER_HOME, 'browsers')
  if (!existsSync(browsersDir)) return

  for (const entry of readdirSync(browsersDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('chrome-')) {
      rmSync(join(browsersDir, entry.name), { recursive: true, force: true })
    }
  }
}

function extractChromeForTestingArchive(url, zipPath, extractDir) {
  run(pyBin, [
    '-c',
    [
      'import sys',
      'import urllib.request',
      'import zipfile',
      'url, zip_path, extract_dir = sys.argv[1:4]',
      'urllib.request.urlretrieve(url, zip_path)',
      'with zipfile.ZipFile(zip_path) as archive:',
      '    archive.extractall(extract_dir)',
    ].join('\n'),
    url,
    zipPath,
    extractDir,
  ])
}

function extractedChromeBundleDir(extractDir) {
  const entries = readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('chrome-'))
    .map(entry => join(extractDir, entry.name))
  if (entries.length === 0) return null
  return entries[0]
}

function pinChromeForTestingBundle() {
  if (!shouldPinChromeForTesting()) return

  const targetBrowsersDir = join(AGENT_BROWSER_HOME, 'browsers')
  const targetBundleDir = join(targetBrowsersDir, `chrome-${CHROME_FOR_TESTING_VERSION}`)
  const tmpRoot = mkdtempSync(join(tmpdir(), 'hermes-cft-'))
  const zipPath = join(tmpRoot, 'chrome.zip')
  const extractDir = join(tmpRoot, 'extract')
  const url = chromeForTestingUrl()

  try {
    console.log(`→ Pinning Chrome for Testing ${CHROME_FOR_TESTING_VERSION} for ${TARGET_OS}-${TARGET_ARCH}`)
    mkdirSync(extractDir, { recursive: true })
    extractChromeForTestingArchive(url, zipPath, extractDir)

    const bundleDir = extractedChromeBundleDir(extractDir)
    const executable = bundleDir ? findBrowserExecutableUnder(bundleDir, bundledBrowserExecutableNames()) : null
    if (!executable) {
      console.error(`Pinned Chrome for Testing archive did not contain a browser executable: ${url}`)
      process.exit(1)
    }

    removeChromeBundles()
    mkdirSync(targetBrowsersDir, { recursive: true })
    cpSync(bundleDir, targetBundleDir, { recursive: true, force: true, verbatimSymlinks: true })
    console.log(`✓ pinned Chrome for Testing at ${targetBundleDir}`)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

function ensureBundledBrowserExecutable() {
  const bundled = findBrowserInstallInHome(AGENT_BROWSER_HOME)
  if (bundled) return bundled.executable

  const searchedHomes = []
  for (const fallbackHome of defaultAgentBrowserHomes()) {
    if (fallbackHome === AGENT_BROWSER_HOME) continue
    searchedHomes.push(fallbackHome)

    const fallback = findBrowserInstallInHome(fallbackHome)
    if (!fallback) continue

    const targetBrowsersDir = join(AGENT_BROWSER_HOME, 'browsers')
    const targetBundleDir = join(targetBrowsersDir, basename(fallback.bundleDir))
    mkdirSync(targetBrowsersDir, { recursive: true })
    cpSync(fallback.bundleDir, targetBundleDir, { recursive: true, force: true, verbatimSymlinks: true })
    console.log(`✓ copied Chrome bundle into ${targetBundleDir}`)

    return findBundledBrowserExecutable()
  }

  if (searchedHomes.length > 0) {
    console.warn(`! no Chrome bundle found in fallback agent-browser homes: ${searchedHomes.join(', ')}`)
  }
  return null
}

function sitePackagesDir() {
  if (TARGET_OS === 'win32') {
    return resolve(PY_DIR, 'Lib', 'site-packages')
  }
  const libDir = resolve(PY_DIR, 'lib')
  const py = readdirSync(libDir).find(n => /^python\d+\.\d+$/.test(n))
  if (!py) throw new Error(`Could not locate pythonX.Y under ${libDir}`)
  return resolve(libDir, py, 'site-packages')
}

function pythonModuleExists(moduleName) {
  const result = optionalRun(pyBin, [
    '-c',
    `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`,
  ], { stdio: 'ignore' })
  return result.status === 0
}

function removeBrokenDashboardAuthPlugin() {
  if (pythonModuleExists('hermes_cli.dashboard_auth')) return

  const pluginDir = resolve(sitePackagesDir(), 'plugins', 'dashboard_auth', 'nous')
  if (!existsSync(pluginDir)) return

  rmSync(pluginDir, { recursive: true, force: true })
  console.warn(
    '! Removed bundled dashboard_auth/nous plugin because hermes_cli.dashboard_auth is missing from the hermes-agent package',
  )
}

function installBrowserRuntime() {
  if (SKIP_BROWSER_RUNTIME) {
    console.warn('! Skipping bundled browser runtime because HERMES_SKIP_BROWSER_RUNTIME is set')
    return
  }
  if (BROWSER_PACKAGES.length === 0) {
    console.warn('! Skipping bundled browser runtime because HERMES_BROWSER_PACKAGES is empty')
    return
  }

  const npm = npmCommand()
  if (!npm) {
    console.error('npm not found; bundled browser runtime requires Node.js/npm')
    process.exit(1)
  }

  console.log(`→ Installing browser runtime via npm prefix ${NODE_PREFIX}`)
  runInvocation(npm, [
    'install',
    '-g',
    '--prefix',
    NODE_PREFIX,
    '--silent',
    '--ignore-scripts',
    ...BROWSER_PACKAGES,
  ])

  const ab = agentBrowserCommand()
  if (!existsSync(ab)) {
    console.error(`agent-browser binary not found at ${ab} after npm install`)
    process.exit(1)
  }

  console.log(`→ Installing Chromium for bundled agent-browser at ${AGENT_BROWSER_HOME}`)
  runInvocation(commandInvocation(ab), ['install'], { env: browserRuntimeEnv() })
  pinChromeForTestingBundle()

  const browserExecutable = ensureBundledBrowserExecutable()
  if (!browserExecutable) {
    console.error(`Bundled Chrome executable not found under ${AGENT_BROWSER_HOME} after agent-browser install`)
    process.exit(1)
  }
  console.log(`✓ bundled Chrome executable available at ${browserExecutable}`)
}

installPythonPackages([HERMES_PACKAGE], 'hermes-agent')
installPythonPackages(EXTRA_PYTHON_PACKAGES, 'extra Python runtime packages')
removeBrokenDashboardAuthPlugin()
installBrowserRuntime()

run(pyBin, [
  '-c',
  [
    'import importlib.util',
    'import mcp',
    'import tools.mcp_tool as t',
    'assert t._MCP_AVAILABLE',
    'assert importlib.util.find_spec("websockets") is not None',
  ].join('; '),
])

const hermesBin = TARGET_OS === 'win32'
  ? resolve(PY_DIR, 'Scripts', 'hermes.cmd')
  : resolve(PY_DIR, 'bin', 'hermes')
const hermesCheckCommand = TARGET_OS === 'win32' ? pyBin : hermesBin
const hermesCheckArgs = TARGET_OS === 'win32' ? ['-m', 'hermes_cli.main', '--version'] : ['--version']

// hermes-web-ui's agent-bridge searches for `run_agent.py` at <python_root>/run_agent.py
// (and a few neighbouring dirs). pip places it at site-packages/run_agent.py — surface
// it at the venv root with a *relative* symlink so the venv stays portable when copied
// into the packaged .app/.exe (an absolute symlink would break the moment the bundle
// is moved to /Applications/...).
function siteRunAgentRelative() {
  if (TARGET_OS === 'win32') {
    return ['Lib', 'site-packages', 'run_agent.py'].join('\\')
  }
  return `${sitePackagesDir().slice(PY_DIR.length + 1)}/run_agent.py`
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
if (TARGET_OS === 'win32') {
  // Windows: uv/pip .exe launchers can embed build-machine paths. Replace the
  // Hermes entry points with relocatable .cmd wrappers and remove the .exe
  // trampolines so PATHEXT lookups cannot pick a stale launcher first.
  const wrappers = [
    ['hermes', 'hermes_cli.main'],
    ['hermes-agent', 'run_agent'],
    ['hermes-acp', 'acp_adapter.entry'],
  ]
  for (const [name, mod] of wrappers) {
    const cmdPath = resolve(PY_DIR, 'Scripts', `${name}.cmd`)
    writeFileSync(
      cmdPath,
      [
        '@echo off',
        'set "PY=%~dp0..\\python.exe"',
        `"%PY%" -m ${mod} %*`,
      ].join('\r\n'),
    )
    rmSync(resolve(PY_DIR, 'Scripts', `${name}.exe`), { force: true })
  }
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

if (!existsSync(hermesBin)) {
  console.error(`hermes binary not found at ${hermesBin} after install`)
  process.exit(1)
}

run(hermesCheckCommand, hermesCheckArgs)

if (!SKIP_BROWSER_RUNTIME) {
  run(pyBin, [
    '-c',
    [
      'import os, shutil',
      `os.environ["PLAYWRIGHT_BROWSERS_PATH"] = ${JSON.stringify(PLAYWRIGHT_BROWSERS_PATH)}`,
      'from tools.browser_tool import _chromium_installed',
      'assert shutil.which("agent-browser") is not None',
      'assert _chromium_installed()',
    ].join('; '),
  ], { env: browserRuntimeEnv() })
}

if (SKIP_BROWSER_RUNTIME) {
  console.log('✓ hermes Python, MCP, and websockets checks passed; browser runtime skipped')
} else {
  console.log('✓ hermes Python, MCP, websockets, agent-browser, and Chromium checks passed')
}
