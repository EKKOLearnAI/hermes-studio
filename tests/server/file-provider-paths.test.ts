import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { normalizePlatformPath, validatePath } from '../../packages/server/src/services/hermes/file-provider'
import { isPathWithin, relativePathFromBase } from '../../packages/server/src/services/hermes/hermes-path'

describe('file provider platform path normalization', () => {
  it('converts MSYS drive paths to Windows absolute paths on Windows', () => {
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'win32'))
      .toBe('C:\\Users\\Administrator\\Desktop\\screenshot.png')
    expect(normalizePlatformPath('/d/tmp/report.txt', 'win32'))
      .toBe('D:\\tmp\\report.txt')
  })

  it('leaves MSYS-style paths unchanged on non-Windows platforms', () => {
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'darwin'))
      .toBe('/c/Users/Administrator/Desktop/screenshot.png')
    expect(normalizePlatformPath('/c/Users/Administrator/Desktop/screenshot.png', 'linux'))
      .toBe('/c/Users/Administrator/Desktop/screenshot.png')
  })

  it('leaves normal Windows paths unchanged', () => {
    expect(normalizePlatformPath('C:\\Users\\Administrator\\Desktop\\screenshot.png', 'win32'))
      .toBe('C:\\Users\\Administrator\\Desktop\\screenshot.png')
  })

  it('allows literal double dots inside safe absolute path segments', () => {
    const filePath = join(tmpdir(), 'foo..bar.txt')

    expect(validatePath(filePath)).toBe(resolve(filePath))
  })

  it('rejects parent-directory traversal segments', () => {
    const filePath = `${join(tmpdir(), 'safe')}/../evil.txt`

    expect(() => validatePath(filePath)).toThrow('Invalid file path')
  })
})

describe('Hermes path containment helpers', () => {
  it('does not treat sibling paths with the same prefix as inside the base', () => {
    expect(isPathWithin('/tmp/hermes-profile2/state.db', '/tmp/hermes-profile')).toBe(false)
    expect(isPathWithin('/tmp/hermes-profile/state.db', '/tmp/hermes-profile')).toBe(true)
  })

  it('returns normalized relative paths only for children', () => {
    expect(relativePathFromBase('/tmp/hermes-profile/logs/run.txt', '/tmp/hermes-profile'))
      .toBe('logs/run.txt')
    expect(relativePathFromBase('/tmp/hermes-profile2/logs/run.txt', '/tmp/hermes-profile'))
      .toBeNull()
  })
})
