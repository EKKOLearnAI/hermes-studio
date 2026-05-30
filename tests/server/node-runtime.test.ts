import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCurrentNodeEnv,
  getManagedNpmBinDir,
  getManagedNpmPrefix,
  getNpmExecution,
} from '../../packages/server/src/services/node-runtime'

describe('node-runtime', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the project-local npm cli when available', () => {
    const execution = getNpmExecution(['--version'])

    expect(execution.command).toBe(process.execPath)
    expect(execution.args[0]).toContain(join('node_modules', 'npm', 'bin', 'npm-cli.js'))
    expect(execution.args.slice(1)).toEqual(['--version'])
  })

  it('creates a desktop node shim and writable npm prefix', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-runtime-'))
    tempDirs.push(home)
    vi.stubEnv('HERMES_DESKTOP', 'true')
    vi.stubEnv('HERMES_WEB_UI_HOME', home)

    const env = getCurrentNodeEnv({ PATH: '/custom/bin' })
    const prefix = getManagedNpmPrefix()
    const shimPath = join(home, 'node-runtime', 'bin', process.platform === 'win32' ? 'node.cmd' : 'node')

    expect(prefix).toBe(join(home, 'node-tools'))
    expect(env.npm_config_prefix).toBe(prefix)
    expect(env.PATH?.split(delimiter)).toContain(join(home, 'node-runtime', 'bin'))
    expect(env.PATH?.split(delimiter)).toContain(getManagedNpmBinDir(prefix))
    expect(env.PATH?.split(delimiter)).toContain('/custom/bin')
    expect(existsSync(shimPath)).toBe(true)
    expect(readFileSync(shimPath, 'utf-8')).toContain('ELECTRON_RUN_AS_NODE')
  })
})
