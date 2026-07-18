import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

function pngSize(path: string): { width: number; height: number } {
  const png = readFileSync(resolve(path))
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  }
}

describe('desktop app icon', () => {
  it('ships the cross-platform source and every required Linux PNG size', () => {
    expect(pngSize('packages/desktop/build/icon.png')).toEqual({ width: 1024, height: 1024 })
    for (const size of [16, 32, 48, 64, 128, 256, 512]) {
      expect(pngSize(`packages/desktop/build/icons/${size}x${size}.png`)).toEqual({ width: size, height: size })
    }
  })

  it('ships native macOS and Windows icon containers', () => {
    const icns = readFileSync(resolve('packages/desktop/build/icon.icns'))
    const ico = readFileSync(resolve('packages/desktop/build/icon.ico'))

    expect(icns.subarray(0, 4).toString()).toBe('icns')
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0])
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(7)
  })

  it('uses an unmasked Icon Composer source on macOS and separate Windows and Linux assets', () => {
    const composerPng = readFileSync(resolve('packages/desktop/build/icon.icon/Assets/hermes-logo.png'))
    const composer = JSON.parse(readFileSync(resolve('packages/desktop/build/icon.icon/icon.json'), 'utf8'))
    const builderConfig = readFileSync(resolve('packages/desktop/electron-builder.yml'), 'utf8')
    const desktopPackage = JSON.parse(readFileSync(resolve('packages/desktop/package.json'), 'utf8'))

    expect(pngSize('packages/desktop/build/icon.icon/Assets/hermes-logo.png')).toEqual({ width: 1024, height: 1024 })
    expect(composerPng.readUInt8(25)).toBe(2)
    expect(composer.groups[0].layers[0].glass).toBe(false)
    expect(composer['supported-platforms'].squares).toEqual(['macOS'])
    expect(builderConfig).toContain('icon: build/icon.icon')
    expect(builderConfig).toContain('icon: build/icon.ico')
    expect(builderConfig).toContain('icon: build/icons')
    expect(desktopPackage.devDependencies['electron-builder']).toMatch(/^\^26\./)
  })

  it('builds macOS artifacts on runners that provide Xcode 26', () => {
    const releaseWorkflow = readFileSync(resolve('.github/workflows/desktop-release.yml'), 'utf8')
    const manualWorkflow = readFileSync(resolve('.github/workflows/desktop-manual-build.yml'), 'utf8')

    for (const workflow of [releaseWorkflow, manualWorkflow]) {
      expect(workflow).toContain('macos-26')
      expect(workflow).toContain('macos-26-intel')
    }
  })
})
