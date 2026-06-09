import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HERMES_CLI_ARG } from './cli-constants'

const execFileAsync = promisify(execFile)

const SHIM_MARKER = 'HERMES_STUDIO_CLI_SHIM'
const MCP_SHIM_MARKER = 'HERMES_STUDIO_MCP_SHIM'
const PATH_MARKER_START = '# >>> Hermes Studio CLI shim >>>'
const PATH_MARKER_END = '# <<< Hermes Studio CLI shim <<<'

type ShimInstallStatus = 'installed' | 'updated' | 'unchanged' | 'skipped'

export interface CliShimInstallResult {
  shimPath: string
  status: ShimInstallStatus
  pathUpdated: boolean
  reason?: string
}

interface CliShimInstallOptions {
  env?: NodeJS.ProcessEnv
  executablePath?: string
  homeDir?: string
  platform?: NodeJS.Platform
  runtimeVersion?: string
}

interface McpShimInstallOptions extends CliShimInstallOptions {
  nodePath?: string
  scriptPath?: string
  webUiUrl?: string
}

function platformDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : delimiter
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const normalized = resolve(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function pathContainsDir(pathValue: string | undefined, binDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!pathValue) return false
  const target = pathKey(binDir, platform)
  return pathValue
    .split(platformDelimiter(platform))
    .map(entry => entry.trim())
    .filter(Boolean)
    .some(entry => pathKey(entry, platform) === target)
}

function executableForShim(options: Required<Pick<CliShimInstallOptions, 'env' | 'executablePath' | 'platform'>>): string {
  const appImage = options.platform === 'linux' ? options.env.APPIMAGE?.trim() : ''
  return appImage || options.executablePath
}

export function shimPathForPlatform(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, platform === 'win32' ? 'hermes-studio.cmd' : 'hermes-studio')
}

export function mcpShimPathForPlatform(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, platform === 'win32' ? 'hermes-studio-mcp.cmd' : 'hermes-studio-mcp')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function windowsRuntimePlatformKey(archName: string): string {
  return `win-${archName}`
}

export function createShimContent(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  archName: string = process.arch,
  runtimeVersion = '0.15.2',
): string {
  if (platform === 'win32') {
    const runtimePlatform = windowsRuntimePlatformKey(archName)
    return [
      '@echo off',
      `rem ${SHIM_MARKER}`,
      `set "APP=${executablePath}"`,
      'set "WEBUI_HOME=%HERMES_WEB_UI_HOME%"',
      'if "%WEBUI_HOME%"=="" set "WEBUI_HOME=%HERMES_WEBUI_STATE_DIR%"',
      'if "%WEBUI_HOME%"=="" set "WEBUI_HOME=%USERPROFILE%\\.hermes-web-ui"',
      'set "RUNTIME=%HERMES_DESKTOP_RUNTIME_DIR%"',
      'if "%RUNTIME%"=="" if exist "%WEBUI_HOME%\\desktop-runtime\\active-version.json" (',
      `  for /f "usebackq delims=" %%I in (\`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Join-Path $env:WEBUI_HOME 'desktop-runtime\\active-version.json'; try { $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; if ($j.platform -eq '${runtimePlatform}' -and $j.runtimeDirectory -and (Test-Path -LiteralPath $j.runtimeDirectory)) { [Console]::Out.Write($j.runtimeDirectory) } } catch {}" 2^>nul\`) do set "RUNTIME=%%I"`,
      ')',
      `if "%RUNTIME%"=="" set "RUNTIME=%WEBUI_HOME%\\desktop-runtime\\hermes\\${runtimeVersion}\\${runtimePlatform}"`,
      'set "PYTHON=%RUNTIME%\\python\\python.exe"',
      'if not exist "%PYTHON%" (',
      '  echo Hermes Studio Python runtime not found at "%PYTHON%" 1>&2',
      '  echo Open Hermes Studio once to finish runtime setup, then retry hermes-studio. 1>&2',
      '  exit /b 127',
      ')',
      '"%PYTHON%" -m hermes_cli.main %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}`,
    `APP=${shellQuote(executablePath)}`,
    'if [ ! -x "$APP" ]; then',
    '  echo "Hermes Studio executable not found at $APP" >&2',
    '  exit 127',
    'fi',
    'unset ELECTRON_RUN_AS_NODE',
    `exec "$APP" -- ${HERMES_CLI_ARG} "$@"`,
    '',
  ].join('\n')
}

export function createMcpShimContent(
  nodePath: string,
  scriptPath: string,
  webUiUrl = 'http://127.0.0.1:8748',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `rem ${MCP_SHIM_MARKER}`,
      `set "NODE=${nodePath}"`,
      `set "SCRIPT=${scriptPath}"`,
      'if not exist "%NODE%" (',
      '  echo Hermes Studio Node runtime not found at "%NODE%" 1>&2',
      '  echo Open Hermes Studio once to finish runtime setup, then retry hermes-studio-mcp. 1>&2',
      '  exit /b 127',
      ')',
      'if not exist "%SCRIPT%" (',
      '  echo Hermes Studio MCP script not found at "%SCRIPT%" 1>&2',
      '  exit /b 127',
      ')',
      'if "%HERMES_WEB_UI_URL%"=="" (',
      '  if "%HERMES_DESKTOP_PORT%"=="" (',
      `    set "HERMES_WEB_UI_URL=${webUiUrl}"`,
      '  ) else (',
      '    set "HERMES_WEB_UI_URL=http://127.0.0.1:%HERMES_DESKTOP_PORT%"',
      '  )',
      ')',
      'set "HERMES_MCP_SERVER_NAME=hermes-studio-mcp"',
      '"%NODE%" "%SCRIPT%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    `# ${MCP_SHIM_MARKER}`,
    `NODE=${shellQuote(nodePath)}`,
    `SCRIPT=${shellQuote(scriptPath)}`,
    'if [ ! -x "$NODE" ]; then',
    '  echo "Hermes Studio Node runtime not found at $NODE" >&2',
    '  echo "Open Hermes Studio once to finish runtime setup, then retry hermes-studio-mcp." >&2',
    '  exit 127',
    'fi',
    'if [ ! -f "$SCRIPT" ]; then',
    '  echo "Hermes Studio MCP script not found at $SCRIPT" >&2',
    '  exit 127',
    'fi',
    'if [ -z "${HERMES_WEB_UI_URL:-}" ]; then',
    '  if [ -n "${HERMES_DESKTOP_PORT:-}" ]; then',
    '    HERMES_WEB_UI_URL="http://127.0.0.1:${HERMES_DESKTOP_PORT}"',
    '  else',
    `    HERMES_WEB_UI_URL=${shellQuote(webUiUrl)}`,
    '  fi',
    'fi',
    'export HERMES_WEB_UI_URL',
    'export HERMES_MCP_SERVER_NAME=hermes-studio-mcp',
    'exec "$NODE" "$SCRIPT" "$@"',
    '',
  ].join('\n')
}

function isManagedShim(content: string, marker: string): boolean {
  return content.includes(marker)
}

function writeShim(shimPath: string, content: string, platform: NodeJS.Platform, marker = SHIM_MARKER): ShimInstallStatus {
  if (existsSync(shimPath)) {
    const existing = readFileSync(shimPath, 'utf-8')
    if (existing === content) return 'unchanged'
    if (!isManagedShim(existing, marker)) return 'skipped'
    writeFileSync(shimPath, content, 'utf-8')
    if (platform !== 'win32') chmodSync(shimPath, 0o755)
    return 'updated'
  }

  writeFileSync(shimPath, content, { encoding: 'utf-8', mode: platform === 'win32' ? 0o644 : 0o755 })
  if (platform !== 'win32') chmodSync(shimPath, 0o755)
  return 'installed'
}

function shellProfilePaths(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return []

  const shell = env.SHELL?.trim() || ''
  const name = shell.split('/').pop() || ''
  if (name === 'fish') return [join(homeDir, '.config', 'fish', 'conf.d', 'hermes-studio.fish')]
  if (name === 'bash') return [join(homeDir, '.bash_profile'), join(homeDir, '.bashrc')]
  if (name === 'zsh' || platform === 'darwin') return [join(homeDir, '.zprofile'), join(homeDir, '.zshrc')]
  return [join(homeDir, '.profile')]
}

function profileMentionsUserBin(content: string, homeDir: string): boolean {
  return content.includes('$HOME/bin')
    || content.includes('~/bin')
    || content.includes(resolve(homeDir, 'bin'))
}

function shellPathSnippet(platform: NodeJS.Platform, profilePath: string): string {
  if (platform !== 'win32' && profilePath.endsWith('.fish')) {
    return [
      '',
      PATH_MARKER_START,
      'fish_add_path -m "$HOME/bin"',
      PATH_MARKER_END,
      '',
    ].join('\n')
  }

  return [
    '',
    PATH_MARKER_START,
    'case ":$PATH:" in',
    '  *":$HOME/bin:"*) ;;',
    '  *) export PATH="$HOME/bin:$PATH" ;;',
    'esac',
    PATH_MARKER_END,
    '',
  ].join('\n')
}

async function ensureWindowsUserPath(binDir: string): Promise<boolean> {
  let currentPath = ''
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf-8',
      timeout: 1500,
      windowsHide: true,
    })
    const line = stdout.split(/\r?\n/).find(row => /^\s*Path\s+REG_/.test(row))
    if (line) currentPath = line.replace(/^\s*Path\s+REG_\w+\s+/, '').trim()
  } catch {
    currentPath = process.env.Path || process.env.PATH || ''
  }

  if (pathContainsDir(currentPath, binDir, 'win32')) return false

  const separator = currentPath ? ';' : ''
  await execFileAsync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', `${binDir}${separator}${currentPath}`, '/f'], {
    encoding: 'utf-8',
    timeout: 1500,
    windowsHide: true,
  })
  return true
}

function ensureUnixShellPath(homeDir: string, binDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (pathContainsDir(env.PATH, binDir, platform)) return false

  let updated = false
  for (const profilePath of shellProfilePaths(homeDir, platform, env)) {
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : ''
    if (existing.includes(PATH_MARKER_START) || profileMentionsUserBin(existing, homeDir)) continue

    mkdirSync(dirname(profilePath), { recursive: true })
    appendFileSync(profilePath, shellPathSnippet(platform, profilePath), 'utf-8')
    updated = true
    break
  }
  return updated
}

async function ensureUserBinOnPath(homeDir: string, binDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (platform === 'win32') {
    return await ensureWindowsUserPath(binDir)
  }
  return ensureUnixShellPath(homeDir, binDir, platform, env)
}

export async function installHermesStudioCliShim(options: CliShimInstallOptions = {}): Promise<CliShimInstallResult> {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const homeDir = options.homeDir || homedir()
  const binDir = resolve(homeDir, 'bin')
  const executablePath = executableForShim({
    env,
    executablePath: options.executablePath || process.execPath,
    platform,
  })
  const shimPath = shimPathForPlatform(binDir, platform)

  mkdirSync(binDir, { recursive: true })
  const status = writeShim(shimPath, createShimContent(executablePath, platform, process.arch, options.runtimeVersion), platform)
  const pathUpdated = await ensureUserBinOnPath(homeDir, binDir, platform, env).catch((err) => {
    console.warn(`[cli-shim] failed to update PATH: ${err instanceof Error ? err.message : String(err)}`)
    return false
  })

  return {
    shimPath,
    status,
    pathUpdated,
    reason: status === 'skipped' ? 'existing hermes-studio shim is not managed by Hermes Studio' : undefined,
  }
}

export async function installHermesStudioMcpShim(options: McpShimInstallOptions = {}): Promise<CliShimInstallResult> {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const homeDir = options.homeDir || homedir()
  const binDir = resolve(homeDir, 'bin')
  const shimPath = mcpShimPathForPlatform(binDir, platform)
  const nodePath = options.nodePath || process.execPath
  const scriptPath = options.scriptPath || resolve(process.cwd(), 'bin', 'hermes-web-ui-mcp.mjs')
  const webUiUrl = options.webUiUrl || 'http://127.0.0.1:8748'

  mkdirSync(binDir, { recursive: true })
  const status = writeShim(shimPath, createMcpShimContent(nodePath, scriptPath, webUiUrl, platform), platform, MCP_SHIM_MARKER)
  const pathUpdated = await ensureUserBinOnPath(homeDir, binDir, platform, env).catch((err) => {
    console.warn(`[cli-shim] failed to update PATH: ${err instanceof Error ? err.message : String(err)}`)
    return false
  })

  return {
    shimPath,
    status,
    pathUpdated,
    reason: status === 'skipped' ? 'existing hermes-studio-mcp shim is not managed by Hermes Studio' : undefined,
  }
}
