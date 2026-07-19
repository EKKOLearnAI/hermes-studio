import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import verifyPackagedWebUi, { targetArchName } from '../../packages/desktop/scripts/verify-packaged-webui.mjs'

const tempRoots: string[] = []

function packagedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-packaged-webui-'))
  tempRoots.push(root)
  return root
}

function createPackagedWebUi(appOutDir: string): void {
  const webUiRoot = join(appOutDir, 'resources', 'webui')
  const files = [
    'package.json',
    'bin/hermes-web-ui.mjs',
    'dist/server/index.js',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/socket.io/package.json',
  ]
  for (const file of files) {
    const target = join(webUiRoot, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
}

function createCompiledLinuxNodePty(appOutDir: string): void {
  const nodePtyRoot = join(appOutDir, 'resources', 'webui', 'node_modules', 'node-pty')
  rmSync(join(nodePtyRoot, 'prebuilds'), { recursive: true, force: true })
  const target = join(nodePtyRoot, 'build', 'Release', 'pty.node')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '')
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged desktop Web UI', () => {
  it('maps electron-builder architecture values without desktop-only dependencies', () => {
    expect(targetArchName(1)).toBe('x64')
    expect(targetArchName(3)).toBe('arm64')
  })

  it('copies production dependencies through a dedicated node_modules matcher', () => {
    const config = readFileSync(resolve('packages/desktop/electron-builder.yml'), 'utf8')

    expect(config).toContain('afterPack: "./scripts/verify-packaged-webui.mjs"')
    expect(config).toContain('from: "../../node_modules"')
    expect(config).toContain('to: "webui/node_modules"')
    const buildExclusion = config.indexOf('!node-pty/build/**')
    expect(buildExclusion).toBeGreaterThan(-1)
    expect(config.indexOf('node-pty/build/Release/pty.node')).toBeGreaterThan(buildExclusion)
  })

  it('uses the electron-builder 26 desktop entry schema for deb packages', () => {
    const script = readFileSync(resolve('packages/desktop/scripts/electron-builder.mjs'), 'utf8')

    expect(script).toContain('--config.linux.desktop.entry.Name=Hermes Studio')
    expect(script).not.toContain('--config.linux.desktop.Name=Hermes Studio')
  })

  it('accepts a package containing the server and target native dependencies', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Hermes Studio' } },
    } as never)).resolves.toBeUndefined()
  })

  it('rejects a package that omitted production dependencies', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules'), { recursive: true, force: true })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Hermes Studio' } },
    } as never)).rejects.toThrow('Packaged Web UI is incomplete')
  })

  it('accepts source-built node-pty runtime files on Linux', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    createCompiledLinuxNodePty(appOutDir)

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 3,
      packager: { appInfo: { productFilename: 'Hermes Studio' } },
    } as never)).resolves.toBeUndefined()
  })

  it('rejects a missing source-built node-pty module on Linux', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    createCompiledLinuxNodePty(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'))

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 3,
      packager: { appInfo: { productFilename: 'Hermes Studio' } },
    } as never)).rejects.toThrow('pty.node')
  })
})
