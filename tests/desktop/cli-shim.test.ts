import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMcpPowerShellShimContent,
  createMcpShimContent,
  createPowerShellShimContent,
  createShimContent,
  installHermesStudioCliShim,
  pathContainsDir,
  shimPathForPlatform,
} from '../../packages/desktop/src/main/cli-shim'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execFile: execFileMock,
  }
})

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

function decodedPowerShellValues(content: string): string[] {
  return [...content.matchAll(/FromBase64String\('([^']+)'\)/g)]
    .map(match => Buffer.from(match[1], 'base64').toString('utf-8'))
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
    const command = createShimContent(
      'C:\\Users\\Example\\AppData\\Local\\Programs\\Hermes Studio\\Hermes Studio.exe',
      'win32',
      'x64',
      undefined,
      'C:\\runtime\\node\\node.exe',
      'C:\\resources\\webui\\bin\\hermes-web-ui.mjs',
    )
    const powershell = createPowerShellShimContent(
      'C:\\Users\\Example\\AppData\\Local\\Programs\\Hermes Studio\\Hermes Studio.exe',
      'x64',
      undefined,
      'C:\\runtime\\node\\node.exe',
      'C:\\resources\\webui\\bin\\hermes-web-ui.mjs',
    )
    const [appPath, nodePath, webUiScriptPath, forwarder] = decodedPowerShellValues(powershell)

    expect(command).toContain('@echo off')
    expect(command).toContain('powershell.exe -NoProfile -NonInteractive')
    expect(command).toContain('-File "%~dp0hermes-studio.ps1" %*')
    expect(command).not.toContain('C:\\runtime')
    expect([...Buffer.from(command)].every(byte => byte < 0x80)).toBe(true)
    expect(appPath).toBe('C:\\Users\\Example\\AppData\\Local\\Programs\\Hermes Studio\\Hermes Studio.exe')
    expect(nodePath).toBe('C:\\runtime\\node\\node.exe')
    expect(webUiScriptPath).toBe('C:\\resources\\webui\\bin\\hermes-web-ui.mjs')
    expect(forwarder).toContain("path.join(webUiHome,'desktop-runtime','hermes','0.19.1','win-x64')")
    expect(forwarder).toContain("path.join(webUiHome,'desktop-runtime','active-version.json')")
    expect(forwarder).toContain("active.platform==='win-x64'")
    expect(forwarder).toContain("let virtualEnv=path.join(runtime,'python','venv')")
    expect(forwarder).toContain("cp.spawnSync(python,['-m','hermes_cli.main',...args]")
    expect(forwarder).toContain("{stdio:'inherit',windowsHide:true,env}")
    expect(powershell).toContain('[string[]]$ForwardArgs = @()')
    expect(powershell).toContain('$ForwardArgs = [string[]]$CommandArgs[1..($CommandArgs.Count - 1)]')
    expect(powershell).toContain('& $Node -e $CliForwarder @ForwardArgs')
    expect(powershell).toContain('& $Node $WebUiScript @ForwardArgs')
    expect(powershell).not.toContain('C:\\runtime')
    expect([...Buffer.from(powershell)].every(byte => byte < 0x80)).toBe(true)
  })

  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('preserves a single CLI argument when the PowerShell sidecar runs', () => {
    const homeDir = tempHome()
    const fakeNodePath = join(homeDir, 'fake-node.ps1')
    const shimPath = join(homeDir, 'hermes-studio.ps1')
    writeFileSync(fakeNodePath, [
      '$args | ForEach-Object {',
      '  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)))',
      '}',
      '',
    ].join('\r\n'), 'ascii')
    writeFileSync(shimPath, createPowerShellShimContent(
      'C:\\Program Files\\Hermes Studio\\Hermes Studio.exe',
      'x64',
      '0.19.1',
      fakeNodePath,
      'C:\\Program Files\\Hermes Studio\\resources\\webui\\bin\\hermes-web-ui.mjs',
    ), 'ascii')

    const encodedArgs = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      shimPath,
      'cli',
      'version',
    ], { encoding: 'utf-8' }).trim().split(/\r?\n/)
    const forwardedArgs = encodedArgs.map(value => Buffer.from(value, 'base64').toString('utf-8'))

    expect(forwardedArgs).toHaveLength(3)
    expect(forwardedArgs[0]).toBe('-e')
    expect(forwardedArgs[2]).toBe('version')
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
    const command = createMcpShimContent('C:\\runtime\\node.exe', 'C:\\resources\\webui\\bin\\hermes-studio-mcp.mjs', 'http://127.0.0.1:8748', 'win32')
    const powershell = createMcpPowerShellShimContent(
      'C:\\runtime\\node.exe',
      'C:\\resources\\webui\\bin\\hermes-studio-mcp.mjs',
      'http://127.0.0.1:8748',
    )

    expect(command).toContain('-File "%~dp0hermes-studio-mcp.ps1" %*')
    expect(powershell).toContain('$env:HERMES_DESKTOP_PORT')
    expect(powershell).toContain("$env:HERMES_WEB_UI_URL = 'http://127.0.0.1:' + $env:HERMES_DESKTOP_PORT")
    expect(powershell).toContain("$env:HERMES_MCP_SERVER_NAME = 'hermes-studio-mcp'")
    expect(decodedPowerShellValues(powershell)).toEqual([
      'C:\\runtime\\node.exe',
      'C:\\resources\\webui\\bin\\hermes-studio-mcp.mjs',
      'http://127.0.0.1:8748',
    ])
  })

  it('refreshes packaged command shims after Runtime migration completes', () => {
    const source = readFileSync(
      join(process.cwd(), 'packages', 'desktop', 'src', 'main', 'index.ts'),
      'utf-8',
    )
    const bootstrap = source.slice(
      source.indexOf('async function bootstrap('),
      source.indexOf("ipcMain.handle('hermes-desktop:get-token'"),
    )

    expect(bootstrap.indexOf('await migratePendingRuntimeRoot(updateSplash)')).toBeGreaterThanOrEqual(0)
    expect(bootstrap.indexOf('writeActiveRuntimeVersion()')).toBeGreaterThan(
      bootstrap.indexOf('await migratePendingRuntimeRoot(updateSplash)'),
    )
    expect(bootstrap.indexOf('await installPackagedCommandShims()')).toBeGreaterThan(
      bootstrap.indexOf('writeActiveRuntimeVersion()'),
    )
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
      nodePath: 'D:\\新建文件夹\\hermes\\0.19.1\\win-x64\\node\\node.exe',
      webUiScriptPath: 'D:\\新建文件夹\\webui\\bin\\hermes-web-ui.mjs',
      env: { Path: existingPath },
    })

    const shim = readFileSync(result.shimPath)
    const powershell = readFileSync(join(homeDir, 'bin', 'hermes-studio.ps1'))
    const decodedValues = decodedPowerShellValues(powershell.toString('utf-8'))
    expect(result.status).toBe('installed')
    expect(result.pathUpdated).toBe(true)
    expect(shim.subarray(0, 9).toString('ascii')).toBe('@echo off')
    expect([...shim].every(byte => byte < 0x80)).toBe(true)
    expect([...powershell].every(byte => byte < 0x80)).toBe(true)
    expect(shim.toString('utf-8')).not.toContain('新建文件夹')
    expect(powershell.toString('utf-8')).not.toContain('新建文件夹')
    expect(decodedValues).toContain('D:\\新建文件夹\\hermes\\0.19.1\\win-x64\\node\\node.exe')
    expect(decodedValues).toContain('D:\\新建文件夹\\webui\\bin\\hermes-web-ui.mjs')
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileMock).not.toHaveBeenCalledWith('reg.exe', expect.anything(), expect.anything(), expect.anything())
    expect(writtenPath).toBe(`${join(homeDir, 'bin')};${existingPath}`)
  })

  it('replaces a managed UTF-8 BOM Windows shim with the ASCII trampoline and sidecar', async () => {
    const homeDir = tempHome()
    const binDir = join(homeDir, 'bin')
    const shimPath = join(binDir, 'hermes-studio.cmd')
    const existingPath = `${binDir};C:\\Windows\\System32`
    execFileMock.mockImplementation((command, args, _options, callback) => {
      const script = Array.isArray(args) ? args.join(' ') : ''
      if (command === 'powershell.exe' && script.includes('GetEnvironmentVariable')) {
        callback(null, { stdout: Buffer.from(existingPath, 'utf-8').toString('base64'), stderr: '' })
        return
      }
      callback(new Error(`unexpected command: ${command}`))
    })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(shimPath, `\uFEFF@echo off\r\nrem HERMES_STUDIO_CLI_SHIM\r\n`)

    const result = await installHermesStudioCliShim({
      homeDir,
      platform: 'win32',
      executablePath: 'C:\\Program Files\\Hermes Studio\\Hermes Studio.exe',
      nodePath: 'D:\\新建文件夹\\hermes\\0.19.1\\win-x64\\node\\node.exe',
      webUiScriptPath: 'C:\\Program Files\\Hermes Studio\\resources\\webui\\bin\\hermes-web-ui.mjs',
      env: { Path: existingPath },
    })

    const command = readFileSync(shimPath)
    const powershell = readFileSync(join(binDir, 'hermes-studio.ps1'))
    expect(result.status).toBe('updated')
    expect(result.pathUpdated).toBe(false)
    expect(command.subarray(0, 9).toString('ascii')).toBe('@echo off')
    expect([...command].every(byte => byte < 0x80)).toBe(true)
    expect([...powershell].every(byte => byte < 0x80)).toBe(true)
    expect(decodedPowerShellValues(powershell.toString('utf-8'))).toContain(
      'D:\\新建文件夹\\hermes\\0.19.1\\win-x64\\node\\node.exe',
    )
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
