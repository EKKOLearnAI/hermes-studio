import { describe, expect, it } from 'vitest'
import { isWindowsUpdaterLockError, pendingUpdateDirectories } from '../../packages/desktop/src/main/updater-helpers'

describe('desktop updater helpers', () => {
  it('detects Squirrel locked-exe update failures', async () => {
    expect(isWindowsUpdaterLockError(new Error('Failed to uninstall old application files. Please try running the installer again.: 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('Squirrel update failed with code 2'))).toBe(true)
    expect(isWindowsUpdaterLockError(new Error('network timeout'))).toBe(false)
  })

  it('includes local and roaming pending update cache directories', async () => {
    expect(pendingUpdateDirectories({
      appDataPath: 'C:\\Users\\A\\AppData\\Roaming',
      localAppData: 'C:\\Users\\A\\AppData\\Local',
      appName: 'Hermes Studio',
    })).toEqual(expect.arrayContaining([
      'C:\\Users\\A\\AppData\\Local/Hermes Studio-updater/pending',
      'C:\\Users\\A\\AppData\\Local/hermes-studio-updater/pending',
      'C:\\Users\\A\\AppData\\Roaming/hermes-studio-updater/pending',
    ]))
  })
})
