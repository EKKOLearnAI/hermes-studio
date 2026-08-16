import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

const HOME = '/tmp/hermes-resolve-home'

/**
 * resolveHermesPath decides which paths the file APIs will touch. These pin
 * down the difference between a `..` segment, which is traversal, and a name
 * that merely begins with dots, which is a file.
 */
describe('resolveHermesPath', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../packages/server/src/services/hermes/hermes-profile', () => ({
      getActiveProfileDir: () => HOME,
      getActiveEnvPath: () => join(HOME, '.env'),
      getProfileDir: (profile: string) => join(HOME, 'profiles', profile),
    }))
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
    vi.resetModules()
  })

  async function resolveHermesPath() {
    return (await import('../../packages/server/src/services/hermes/file-provider')).resolveHermesPath
  }

  it('resolves an ordinary relative path under the profile home', async () => {
    const resolve = await resolveHermesPath()
    expect(resolve('skills/notes.md')).toBe(join(HOME, 'skills/notes.md'))
  })

  it('resolves under the requested profile rather than the active one', async () => {
    const resolve = await resolveHermesPath()
    expect(resolve('config.yaml', 'work')).toBe(join(HOME, 'profiles/work/config.yaml'))
  })

  it('accepts names that begin with dots but are not traversal', async () => {
    const resolve = await resolveHermesPath()
    expect(resolve('..hidden')).toBe(join(HOME, '..hidden'))
    expect(resolve('...')).toBe(join(HOME, '...'))
    expect(resolve('notes/..archive.md')).toBe(join(HOME, 'notes/..archive.md'))
  })

  it('rejects a parent-directory segment wherever it appears', async () => {
    const resolve = await resolveHermesPath()
    expect(() => resolve('..')).toThrow('Invalid file path')
    expect(() => resolve('../etc/passwd')).toThrow('Invalid file path')
    expect(() => resolve('skills/../../etc/passwd')).toThrow('Invalid file path')
  })

  it('still refuses an absolute path', async () => {
    const resolve = await resolveHermesPath()
    expect(() => resolve('/etc/passwd')).toThrow('Invalid file path')
    expect(() => resolve(join(HOME, 'skills'))).toThrow('Invalid file path')
  })

  it('returns the home directory for the empty, dot and root forms', async () => {
    const resolve = await resolveHermesPath()
    expect(resolve('')).toBe(HOME)
    expect(resolve('.')).toBe(HOME)
    expect(resolve('/')).toBe(HOME)
  })
})
