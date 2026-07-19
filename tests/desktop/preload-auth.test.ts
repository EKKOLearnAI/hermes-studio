import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('desktop preload auth', () => {
  it('does not auto-login with default credentials', () => {
    const source = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')

    expect(source).not.toContain('/api/auth/login')
    expect(source).not.toContain('DEFAULT_PASSWORD')
    expect(source).not.toContain('DEFAULT_USERNAME')
    expect(source).not.toContain('autoLogin')
  })

  it('exposes the native Runtime directory picker through a dedicated IPC channel', () => {
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf-8')
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf-8')

    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:select-runtime-directory'")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:select-runtime-directory'")
    expect(mainSource).toContain("properties: ['openDirectory']")
  })
})
