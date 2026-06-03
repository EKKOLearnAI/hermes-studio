import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createShimContent,
  installHermesStudioCliShim,
  pathContainsDir,
  shimPathForPlatform,
} from '../../packages/desktop/src/main/cli-shim'

let tempDirs: string[] = []

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
  it('quotes Unix app paths and forwards args through --hermes-cli', () => {
    const content = createShimContent("/Applications/Hermes Studio's.app/Contents/MacOS/Hermes Studio", 'darwin')

    expect(content).toContain("--hermes-cli")
    expect(content).toContain("APP='/Applications/Hermes Studio'\\''s.app/Contents/MacOS/Hermes Studio'")
    expect(content).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(content).toContain('exec "$APP" -- --hermes-cli "$@"')
  })

  it('runs the bundled Python Hermes CLI directly in Windows shims', () => {
    const content = createShimContent(
      'C:\\Users\\Example\\AppData\\Local\\Programs\\Hermes Studio\\Hermes Studio.exe',
      'win32',
      'x64',
    )

    expect(content).toContain('desktop-runtime\\win-x64')
    expect(content).toContain('set "PYTHON=%RUNTIME%\\python\\python.exe"')
    expect(content).toContain('"%PYTHON%" -m hermes_cli.main %*')
    expect(content).not.toContain('"%APP%" -- --hermes-cli')
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
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
    })

    expect(result.status).toBe('installed')
    expect(result.pathUpdated).toBe(true)
    expect(result.shimPath).toBe(shimPathForPlatform(join(homeDir, 'bin'), 'darwin'))
    expect(readFileSync(result.shimPath, 'utf-8')).toContain('exec "$APP" -- --hermes-cli "$@"')
    expect(readFileSync(join(homeDir, '.zprofile'), 'utf-8')).toContain('export PATH="$HOME/bin:$PATH"')
  })
})
