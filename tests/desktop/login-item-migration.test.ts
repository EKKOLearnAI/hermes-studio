import type { LoginItemSettings } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { migrateWindowsLoginItem } from '../../packages/desktop/src/main/login-item-migration'

const appId = 'com.hermeswebui.studio'
const executable = 'D:\\Custom Apps\\Studio\\Ekko Studio.exe'
const legacyPath = 'D:\\Custom Apps\\Studio\\Hermes Studio.exe'
type LaunchItem = NonNullable<LoginItemSettings['launchItems']>[number]

function fixture(overrides: Partial<LaunchItem> = {}) {
  const item: LaunchItem = {
    name: appId, path: legacyPath, args: ['--hidden'], scope: 'user', enabled: true,
    ...overrides,
  }
  const settings = { launchItems: [item] } as LoginItemSettings
  const app = {
    isPackaged: true,
    getLoginItemSettings: vi.fn(() => settings),
    setLoginItemSettings: vi.fn(),
  }
  return { app, item, settings }
}

describe('Windows login item migration across the Studio rename', () => {
  it.each([true, false])('preserves startup approval enabled=%s in a custom installation directory', enabled => {
    const { app } = fixture({ enabled })
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(true)
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({ path: legacyPath, args: ['--hidden'] })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      name: appId, path: executable, args: ['--hidden'], openAtLogin: true, enabled,
    })
  })

  it('does not create a login item when startup was never enabled or the item was removed', () => {
    const { app, settings } = fixture()
    settings.launchItems = []
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(false)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'another-app' },
    { path: 'D:\\Other Studio\\Hermes Studio.exe' },
    { path: executable },
    { args: [] },
    { args: ['--hidden', '--custom-option'] },
    { scope: 'machine' },
  ])('preserves a nonmatching or already migrated entry: %j', overrides => {
    const { app } = fixture(overrides)
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(false)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('matches Windows paths without case sensitivity', () => {
    const { app } = fixture({ path: legacyPath.toUpperCase() })
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(true)
  })

  it('is idempotent after replacing the existing value', () => {
    const { app, item } = fixture()
    app.setLoginItemSettings.mockImplementation(() => { item.path = executable })
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(true)
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(false)
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1)
  })

  it('does not access login items in development or on other platforms', () => {
    const { app } = fixture()
    for (const platform of ['darwin', 'linux'] as const) {
      expect(migrateWindowsLoginItem(app, appId, executable, platform)).toBe(false)
    }
    app.isPackaged = false
    expect(migrateWindowsLoginItem(app, appId, executable, 'win32')).toBe(false)
    expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  })

  it('does not migrate when running a differently named executable', () => {
    const { app } = fixture()
    expect(migrateWindowsLoginItem(app, appId, legacyPath, 'win32')).toBe(false)
    expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  })

  it('surfaces a write failure without deleting the old entry', () => {
    const { app, item } = fixture()
    app.setLoginItemSettings.mockImplementation(() => { throw new Error('registry unavailable') })
    expect(() => migrateWindowsLoginItem(app, appId, executable, 'win32')).toThrow('registry unavailable')
    expect(item.path).toBe(legacyPath)
  })
})
