import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configureDesktopIdentity } from '../../packages/desktop/src/main/desktop-identity'

describe('desktop identity across the Ekko Studio rename', () => {
  it.each([
    { platform: 'macOS', paths: posix, appData: '/Users/test/Library/Application Support' },
    { platform: 'Windows', paths: win32, appData: 'C:\\Users\\test\\AppData\\Roaming' },
    { platform: 'Linux', paths: posix, appData: '/home/test/.config' },
  ])('keeps the existing $platform Chromium profile after changing the display name', ({ paths, appData }) => {
    let name = 'hermes-studio'
    let pinnedUserData: string | undefined
    const app = {
      getPath: (key: string) => {
        if (key !== 'userData') throw new Error(`Unexpected path: ${key}`)
        return pinnedUserData ?? paths.join(appData, name)
      },
      setPath: (key: string, value: string) => {
        if (key !== 'userData') throw new Error(`Unexpected path: ${key}`)
        pinnedUserData = value
      },
      setName: (value: string) => { name = value },
    }
    const oldProfile = paths.join(appData, 'hermes-studio')

    configureDesktopIdentity(app)

    expect(name).toBe('Ekko Studio')
    expect(app.getPath('userData')).toBe(oldProfile)
    configureDesktopIdentity(app)
    expect(app.getPath('userData')).toBe(oldProfile)
  })

  it('preserves an explicitly configured profile path', () => {
    let userData = '/custom/studio-profile'
    const app = {
      getPath: () => userData,
      setPath: (_key: string, value: string) => { userData = value },
      setName: () => {},
    }

    configureDesktopIdentity(app)

    expect(userData).toBe('/custom/studio-profile')
  })
})
