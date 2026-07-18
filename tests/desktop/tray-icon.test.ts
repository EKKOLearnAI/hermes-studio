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

describe('desktop tray icon', () => {
  it('ships the existing app logo at enlarged macOS 1x and 2x menu bar sizes', () => {
    expect(pngSize('packages/desktop/build/trayMac.png')).toEqual({ width: 22, height: 22 })
    expect(pngSize('packages/desktop/build/trayMac@2x.png')).toEqual({ width: 44, height: 44 })

    const builderConfig = readFileSync(resolve('packages/desktop/electron-builder.yml'), 'utf8')
    expect(builderConfig).toContain('- "trayMac.png"')
    expect(builderConfig).toContain('- "trayMac@2x.png"')
  })

  it('preserves the macOS logo colors instead of applying template tinting', () => {
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')
    const pathsSource = readFileSync(resolve('packages/desktop/src/main/paths.ts'), 'utf8')

    expect(mainSource).toContain('? desktopMacTrayIcon()')
    expect(mainSource).toContain("process.platform === 'darwin'\n    ? sourceIcon")
    expect(mainSource).not.toContain('setTemplateImage(true)')
    expect(pathsSource).toContain("'build', 'trayMac.png'")
    expect(pathsSource).not.toContain('trayTemplate.png')
  })
})
