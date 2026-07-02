import { Buffer } from 'node:buffer'
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
const WINDOWS_USER_PATH_ENV_B64 = 'HERMES_STUDIO_WINDOWS_USER_PATH_B64'

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
  nodePath?: string
  platform?: NodeJS.Platform
  runtimeVersion?: string
  webUiScriptPath?: string
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
  runtimeVersion = '0.18.0',
  nodePath = process.execPath,
  webUiScriptPath = resolve(process.cwd(), 'bin', 'hermes-web-ui.mjs'),
): string {
  if (platform === 'win32') {
    const runtimePlatform = windowsRuntimePlatformKey(archName)
    const cliForwarder = `const cp=require('node:child_process');const args=process.argv.slice(1);if(args[0]&&args[0].toLowerCase()==='cli')args.shift();const r=cp.spawnSync(process.env.PYTHON,['-m','hermes_cli.main',...args],{stdio:'inherit'});if(r.error){console.error(r.error.message);process.exit(127)}process.exit(r.status===null?(r.signal?1:0):r.status)`
    const webForwarder = `const cp=require('node:child_process');const args=process.argv.slice(1);if(args[0]&&args[0].toLowerCase()==='web')args.shift();const r=cp.spawnSync(process.env.NODE,[process.env.WEBUI_SCRIPT,...args],{stdio:'inherit'});if(r.error){console.error(r.error.message);process.exit(127)}process.exit(r.status===null?(r.signal?1:0):r.status)`
    return [
      '@echo off',
      `rem ${SHIM_MARKER}`,
      `set "APP=${executablePath}"`,
      `set "NODE=${nodePath}"`,
      `set "WEBUI_SCRIPT=${webUiScriptPath}"`,
      'if "%~1"=="" goto openApp',
      'if /I "%~1"=="help" goto help',
      'if /I "%~1"=="-h" goto help',
      'if /I "%~1"=="--help" goto help',
      'if /I "%~1"=="cli" goto runCli',
      'if /I "%~1"=="web" goto runWeb',
      'echo Unknown Hermes Studio command: %~1 1>&2',
      'echo Run hermes-studio --help for usage. 1>&2',
      'exit /b 2',
      ':resolveRuntime',
      'set "WEBUI_HOME=%HERMES_WEB_UI_HOME%"',
      'if "%WEBUI_HOME%"=="" set "WEBUI_HOME=%HERMES_WEBUI_STATE_DIR%"',
      'if "%WEBUI_HOME%"=="" set "WEBUI_HOME=%USERPROFILE%\\.hermes-web-ui"',
      'set "RUNTIME=%HERMES_DESKTOP_RUNTIME_DIR%"',
      'if "%RUNTIME%"=="" if exist "%WEBUI_HOME%\\desktop-runtime\\active-version.json" (',
      `  for /f "usebackq delims=" %%I in (\`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Join-Path $env:WEBUI_HOME 'desktop-runtime\\active-version.json'; try { $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; if ($j.platform -eq '${runtimePlatform}' -and $j.runtimeDirectory -and (Test-Path -LiteralPath $j.runtimeDirectory)) { [Console]::Out.Write($j.runtimeDirectory) } } catch {}" 2^>nul\`) do set "RUNTIME=%%I"`,
      ')',
      `if "%RUNTIME%"=="" set "RUNTIME=%WEBUI_HOME%\\desktop-runtime\\hermes\\${runtimeVersion}\\${runtimePlatform}"`,
      'set "PYTHON=%RUNTIME%\\python\\python.exe"',
      'exit /b 0',
      ':runCli',
      'call :resolveRuntime',
      'if not exist "%PYTHON%" (',
      '  echo Hermes Studio Python runtime not found at "%PYTHON%" 1>&2',
      '  echo Open Hermes Studio once to finish runtime setup, then retry hermes-studio cli. 1>&2',
      '  exit /b 127',
      ')',
      'if not exist "%NODE%" (',
      '  echo Hermes Studio Node runtime not found at "%NODE%" 1>&2',
      '  echo Open Hermes Studio once to finish runtime setup, then retry hermes-studio cli. 1>&2',
      '  exit /b 127',
      ')',
      `"%NODE%" -e "${cliForwarder}" %*`,
      'exit /b %ERRORLEVEL%',
      ':runWeb',
      'if not exist "%NODE%" (',
      '  echo Hermes Studio Node runtime not found at "%NODE%" 1>&2',
      '  echo Open Hermes Studio once to finish runtime setup, then retry hermes-studio web. 1>&2',
      '  exit /b 127',
      ')',
      'if not exist "%WEBUI_SCRIPT%" (',
      '  echo Hermes Web UI script not found at "%WEBUI_SCRIPT%" 1>&2',
      '  exit /b 127',
      ')',
      `"%NODE%" -e "${webForwarder}" %*`,
      'exit /b %ERRORLEVEL%',
      ':openApp',
      'start "" "%APP%"',
      'exit /b 0',
      ':help',
      'echo Usage: hermes-studio [command] [options]',
      'echo.',
      'echo Commands:',
      'echo   ^(no command^)       Open Hermes Studio desktop app',
      'echo   cli [args...]       Run bundled Hermes Agent CLI',
      'echo   web [args...]       Run bundled hermes-web-ui command',
      'echo   help, -h, --help    Show this help message',
      'exit /b 0',
      '',
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}`,
    `APP=${shellQuote(executablePath)}`,
    `NODE=${shellQuote(nodePath)}`,
    `WEBUI_SCRIPT=${shellQuote(webUiScriptPath)}`,
    'show_help() {',
    '  cat <<\'EOF\'',
    'Usage: hermes-studio [command] [options]',
    '',
    'Commands:',
    '  (no command)       Open Hermes Studio desktop app',
    '  cli [args...]      Run bundled Hermes Agent CLI',
    '  web [args...]      Run bundled hermes-web-ui command',
    '  help, -h, --help   Show this help message',
    'EOF',
    '}',
    'if [ ! -x "$APP" ]; then',
    '  echo "Hermes Studio executable not found at $APP" >&2',
    '  exit 127',
    'fi',
    'unset ELECTRON_RUN_AS_NODE',
    'case "${1:-}" in',
    '  "")',
    '    exec "$APP"',
    '    ;;',
    '  cli)',
    '    shift',
    `    exec "$APP" -- ${HERMES_CLI_ARG} "$@"`,
    '    ;;',
    '  web)',
    '    shift',
    '    if [ ! -x "$NODE" ]; then',
    '      echo "Hermes Studio Node runtime not found at $NODE" >&2',
    '      echo "Open Hermes Studio once to finish runtime setup, then retry hermes-studio web." >&2',
    '      exit 127',
    '    fi',
    '    if [ ! -f "$WEBUI_SCRIPT" ]; then',
    '      echo "Hermes Web UI script not found at $WEBUI_SCRIPT" >&2',
    '      exit 127',
    '    fi',
    '    exec "$NODE" "$WEBUI_SCRIPT" "$@"',
    '    ;;',
    '  help|-h|--help)',
    '    show_help',
    '    exit 0',
    '    ;;',
    '  *)',
    '    echo "Unknown Hermes Studio command: $1" >&2',
    '    echo "Run hermes-studio --help for usage." >&2',
    '    exit 2',
    '    ;;',
    'esac',
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
      'if "%HERMES_MCP_SERVER_NAME%"=="" set "HERMES_MCP_SERVER_NAME=hermes-studio-mcp"',
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
    'if [ -z "${HERMES_MCP_SERVER_NAME:-}" ]; then',
    '  HERMES_MCP_SERVER_NAME=hermes-studio-mcp',
    'fi',
    'export HERMES_MCP_SERVER_NAME',
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

function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
}

async function readWindowsUserPath(): Promise<string> {
  const command = [
    "$value = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($null -ne $value -and $value.Length -gt 0) { [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($value))) }",
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', powershellArgs(command), {
    encoding: 'utf-8',
    timeout: 3000,
    windowsHide: true,
  })
  const encoded = stdout.trim()
  return encoded.length > 0 ? Buffer.from(encoded, 'base64').toString('utf-8') : ''
}

async function writeWindowsUserPath(pathValue: string): Promise<void> {
  const command = [
    `$bytes = [Convert]::FromBase64String($env:${WINDOWS_USER_PATH_ENV_B64})`,
    '$value = [System.Text.Encoding]::UTF8.GetString($bytes)',
    "[Environment]::SetEnvironmentVariable('Path', $value, 'User')",
  ].join('; ')
  await execFileAsync('powershell.exe', powershellArgs(command), {
    encoding: 'utf-8',
    env: {
      ...process.env,
      [WINDOWS_USER_PATH_ENV_B64]: Buffer.from(pathValue, 'utf-8').toString('base64'),
    },
    timeout: 3000,
    windowsHide: true,
  })
}

async function ensureWindowsUserPath(binDir: string): Promise<boolean> {
  const currentPath = await readWindowsUserPath()

  if (pathContainsDir(currentPath, binDir, 'win32')) return false

  const separator = currentPath ? ';' : ''
  await writeWindowsUserPath(`${binDir}${separator}${currentPath}`)
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
  const status = writeShim(shimPath, createShimContent(
    executablePath,
    platform,
    process.arch,
    options.runtimeVersion,
    options.nodePath,
    options.webUiScriptPath,
  ), platform)
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
  const scriptPath = options.scriptPath || resolve(process.cwd(), 'bin', 'hermes-studio-mcp.mjs')
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
