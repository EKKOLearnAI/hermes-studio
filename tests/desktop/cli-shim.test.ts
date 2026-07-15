import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpShimContent,
  createShimContent,
  installHermesStudioCliShim,
  pathContainsDir,
  shimPathForPlatform,
} from '../../packages/desktop/src/main/cli-shim'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

let tempDirs: string[] = []

beforeEach(() => {
  execFileMock.mockReset()
})

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-studio-shim-'))
  tempDirs.push(dir)
  return dir
}

describe('Hermes Studio CLI shim', () => {
  it('quotes Unix app paths and routes app, cli, web, and help commands', () => {
    const content = createShimContent(
      "/Applications/Hermes Studio's.app/Contents/MacOS/Hermes Studio",
      'darwin',
      'arm64',
      '0.15.2',
      '/runtime/node/bin/node',
      '/resources/webui/bin/hermes-web-ui.mjs',
    )

    expect(content).toContain("--hermes-cli")
    expect(content).toContain("APP='/Applications/Hermes Studio'\\''s.app/Contents/MacOS/Hermes Studio'")
    expect(content).toContain("NODE='/runtime/node/bin/node'")
    expect(content).toContain("WEBUI_SCRIPT='/resources/webui/bin/hermes-web-ui.mjs'")
    expect(content).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(content).toContain('case "${1:-}" in')
    expect(content).toContain('exec "$APP"')
    expect(content).toContain('shift')
    expect(content).toContain('exec "$APP" -- --hermes-cli "$@"')
    expect(content).toContain('exec "$NODE" "$WEBUI_SCRIPT" "$@"')
    expect(content).toContain('Usage: hermes-studio [command] [options]')
  })

  it('routes Windows cli and web subcommands through bundled runtime paths', () => {
    const content = createShimContent(
      'C:\\Users\\Example\\AppData\\Local\\Programs\\Hermes Studio\\Hermes Studio.exe',
      'win32',
      'x64',
      undefined,
      'C:\\runtime\\node\\node.exe',
      'C:\\resources\\webui\\bin\\hermes-web-ui.mjs',
    )

    expect(content).toContain('desktop-runtime\\hermes\\0.18.0\\win-x64')
    expect(content).toContain('desktop-runtime\\active-version.json')
    expect(content).toContain("$j.platform -eq 'win-x64'")
    expect(content).toContain('[Console]::Out.Write($j.runtimeDirectory)')
    expect(content).toContain('set "NODE=C:\\runtime\\node\\node.exe"')
    expect(content).toContain('set "WEBUI_SCRIPT=C:\\resources\\webui\\bin\\hermes-web-ui.mjs"')
    expect(content).toContain('set "PYTHON=%RUNTIME%\\python\\python.exe"')
    expect(content).toContain('if /I "%~1"=="cli" goto runCli')
    expect(content).toContain(':runCli')
    expect(content).toContain('call :resolveRuntime')
    expect(content).toContain("if(args[0]&&args[0].toLowerCase()==='cli')args.shift()")
    expect(content).toContain("cp.spawnSync(process.env.PYTHON,['-m','hermes_cli.main',...args]")
    expect(content).toContain('"%NODE%" -e "const cp=require')
    expect(content).toContain('if /I "%~1"=="web" goto runWeb')
    expect(content).toContain(':runWeb')
    expect(content).toContain("if(args[0]&&args[0].toLowerCase()==='web')args.shift()")
    expect(content).toContain('cp.spawnSync(process.env.NODE,[process.env.WEBUI_SCRIPT,...args]')
    expect(content).not.toContain('"%PYTHON%" -m hermes_cli.main %*')
    expect(content).not.toContain('"%NODE%" "%WEBUI_SCRIPT%" %*')
    expect(content).toContain('start "" "%APP%"')
    expect(content).toContain('echo Usage: hermes-studio [command] [options]')
    expect(content).not.toContain('"%APP%" -- --hermes-cli')
  })

  it('sets the desktop MCP URL from HERMES_DESKTOP_PORT when present', () => {
    const content = createMcpShimContent('/runtime/node', '/resources/webui/bin/hermes-studio-mcp.mjs', 'http://127.0.0.1:8748', 'darwin')

    expect(content).toContain('if [ -n "${HERMES_DESKTOP_PORT:-}" ]; then')
    expect(content).toContain('HERMES_WEB_UI_URL="http://127.0.0.1:${HERMES_DESKTOP_PORT}"')
    expect(content).toContain("HERMES_WEB_UI_URL='http://127.0.0.1:8748'")
    expect(content).toContain('if [ -z "${HERMES_MCP_SERVER_NAME:-}" ]; then')
    expect(content).toContain('HERMES_MCP_SERVER_NAME=hermes-studio-mcp')
    expect(content).toContain('export HERMES_MCP_SERVER_NAME')
  })

  it('sets the desktop MCP URL from HERMES_DESKTOP_PORT in Windows shims', () => {
    const content = createMcpShimContent('C:\\runtime\\node.exe', 'C:\\resources\\webui\\bin\\hermes-studio-mcp.mjs', 'http://127.0.0.1:8748', 'win32')

    expect(content).toContain('if "%HERMES_DESKTOP_PORT%"=="" (')
    expect(content).toContain('set "HERMES_WEB_UI_URL=http://127.0.0.1:8748"')
    expect(content).toContain('set "HERMES_WEB_UI_URL=http://127.0.0.1:%HERMES_DESKTOP_PORT%"')
    expect(content).toContain('if "%HERMES_MCP_SERVER_NAME%"=="" set "HERMES_MCP_SERVER_NAME=hermes-studio-mcp"')
  })

  it('detects user bin paths with platform-specific separators', () => {
    expect(pathContainsDir('/usr/bin:/Users/example/bin', '/Users/example/bin', 'darwin')).toBe(true)
    expect(pathContainsDir('C:\\Windows;C:\\Users\\Example\\bin', 'C:\\Users\\Example\\bin', 'win32')).toBe(true)
  })

  it('installs a managed Unix shim and adds ~/bin to a shell profile', async () => {
    const homeDir = tempHome()
    const result = await installHermesStudioCliShim({
      homeDir,
      platform: 'darwin',
      executablePath: '/Applications/Hermes Studio.app/Contents/MacOS/Hermes Studio',
      nodePath: '/runtime/node/bin/node',
      webUiScriptPath: '/resources/webui/bin/hermes-web-ui.mjs',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
    })

    expect(result.status).toBe('installed')
    expect(result.pathUpdated).toBe(true)
    expect(result.shimPath).toBe(shimPathForPlatform(join(homeDir, 'bin'), 'darwin'))
    expect(readFileSync(result.shimPath, 'utf-8')).toContain("NODE='/runtime/node/bin/node'")
    expect(readFileSync(result.shimPath, 'utf-8')).toContain("WEBUI_SCRIPT='/resources/webui/bin/hermes-web-ui.mjs'")
    expect(readFileSync(join(homeDir, '.zprofile'), 'utf-8')).toContain('export PATH="$HOME/bin:$PATH"')
  })

  it('updates Windows user PATH through PowerShell without corrupting Unicode entries', async () => {
    const existingPath = 'C:\\Users\\张三\\工具;C:\\Windows\\System32'
    let writtenPath = ''
    execFileMock.mockImplementation((command, args, options, callback) => {
      const script = Array.isArray(args) ? args.join(' ') : ''
      if (command !== 'powershell.exe') {
        callback(new Error(`unexpected command: ${command}`))
        return
      }
      if (script.includes('GetEnvironmentVariable')) {
        callback(null, { stdout: Buffer.from(existingPath, 'utf-8').toString('base64'), stderr: '' })
        return
      }
      if (script.includes('SetEnvironmentVariable')) {
        writtenPath = Buffer.from(options.env.HERMES_STUDIO_WINDOWS_USER_PATH_B64, 'base64').toString('utf-8')
        callback(null, { stdout: '', stderr: '' })
        return
      }
      callback(new Error(`unexpected PowerShell script: ${script}`))
    })

    const homeDir = tempHome()
    const result = await installHermesStudioCliShim({
      homeDir,
      platform: 'win32',
      executablePath: 'C:\\Program Files\\Hermes Studio\\Hermes Studio.exe',
      nodePath: 'C:\\Program Files\\Hermes Studio\\node.exe',
      webUiScriptPath: 'C:\\Program Files\\Hermes Studio\\resources\\webui\\bin\\hermes-web-ui.mjs',
      env: { Path: existingPath },
    })

    expect(result.status).toBe('installed')
    expect(result.pathUpdated).toBe(true)
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileMock).not.toHaveBeenCalledWith('reg.exe', expect.anything(), expect.anything(), expect.anything())
    expect(writtenPath).toBe(`${join(homeDir, 'bin')};${existingPath}`)
  })

  it('does not rewrite Windows user PATH when the shim directory is already present', async () => {
    const homeDir = tempHome()
    const existingPath = `${join(homeDir, 'bin')};C:\\Users\\张三\\工具`
    execFileMock.mockImplementation((command, args, _options, callback) => {
      const script = Array.isArray(args) ? args.join(' ') : ''
      if (command === 'powershell.exe' && script.includes('GetEnvironmentVariable')) {
        callback(null, { stdout: Buffer.from(existingPath, 'utf-8').toString('base64'), stderr: '' })
        return
      }
      callback(new Error(`unexpected command: ${command}`))
    })

    const result = await installHermesStudioCliShim({
      homeDir,
      platform: 'win32',
      executablePath: 'C:\\Program Files\\Hermes Studio\\Hermes Studio.exe',
      nodePath: 'C:\\Program Files\\Hermes Studio\\node.exe',
      webUiScriptPath: 'C:\\Program Files\\Hermes Studio\\resources\\webui\\bin\\hermes-web-ui.mjs',
      env: { Path: existingPath },
    })

    expect(result.status).toBe('installed')
    expect(result.pathUpdated).toBe(false)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
