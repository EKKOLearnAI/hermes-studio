import { describe, expect, it } from 'vitest'
import { normalizePlatformPath } from '../../packages/server/src/services/hermes/file-provider'

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
})
