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
})
