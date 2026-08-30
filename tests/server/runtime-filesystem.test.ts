import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('fs', async importOriginal => ({
  ...await importOriginal<typeof import('fs')>(),
  renameSync: fsMocks.renameSync,
  rmSync: fsMocks.rmSync,
}))

import {
  cleanupRuntimePath,
  removeRuntimePath,
  renameRuntimePath,
} from '../../packages/server/src/modules/hermes/services/runtime/runtime-filesystem'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function windowsFilesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: Runtime directory is temporarily locked`), { code })
}

describe('runtime filesystem operations', () => {
  beforeEach(() => {
    fsMocks.renameSync.mockReset()
    fsMocks.rmSync.mockReset()
    fsMocks.renameSync.mockReturnValue(undefined)
    fsMocks.rmSync.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('retries recursive Runtime removal on Windows filesystem locks', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    removeRuntimePath('D:\\Runtime 存储\\hermes\\0.20.0')

    expect(fsMocks.rmSync).toHaveBeenCalledWith('D:\\Runtime 存储\\hermes\\0.20.0', {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    })
  })

  it('does not let temporary cleanup failures replace the install error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fsMocks.rmSync.mockImplementation(() => {
      throw windowsFilesystemError('EPERM')
    })

    expect(() => cleanupRuntimePath('D:\\新建文件夹\\.runtime-download-123')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EPERM'))
  })

  it('retries a Windows Runtime directory rename while a scanner holds it', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.useFakeTimers()
    fsMocks.renameSync
      .mockImplementationOnce(() => { throw windowsFilesystemError('EPERM') })
      .mockImplementationOnce(() => { throw windowsFilesystemError('EBUSY') })
      .mockReturnValue(undefined)

    const renamed = renameRuntimePath(
      'D:\\新建文件夹\\.runtime-download-123',
      'D:\\新建文件夹\\hermes\\0.20.0\\win-x64',
    )
    await vi.runAllTimersAsync()

    await expect(renamed).resolves.toBeUndefined()
    expect(fsMocks.renameSync).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-locking rename errors', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const error = windowsFilesystemError('EXDEV')
    fsMocks.renameSync.mockImplementation(() => { throw error })

    await expect(renameRuntimePath('source', 'destination')).rejects.toBe(error)
    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1)
  })
})
