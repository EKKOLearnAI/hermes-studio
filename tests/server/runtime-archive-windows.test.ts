import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractTarGzipArchive } from '../../packages/server/src/modules/hermes/services/runtime/runtime-archive'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('tar', () => ({ x: vi.fn() }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const archive = 'C:\\下载 目录\\runtime.tar.gz'
const target = 'C:\\安装 目录\\runtime'

describe('Windows runtime archive fallback', () => {
  let child: EventEmitter & { stderr: EventEmitter }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.resetAllMocks()
    child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
    vi.mocked(tar.x).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('uses native tar first and passes paths as separate arguments', async () => {
    const pending = extractTarGzipArchive(archive, target)
    expect(spawn).toHaveBeenCalledWith('tar.exe', ['-xzf', archive, '-C', target], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    child.emit('close', 0, null)
    await pending
    expect(tar.x).not.toHaveBeenCalled()
  })

  it('falls back once when tar.exe cannot be found, including its subsequent close event', async () => {
    const pending = extractTarGzipArchive(archive, target)
    child.emit('error', Object.assign(new Error('spawn tar.exe ENOENT'), { code: 'ENOENT' }))
    child.emit('close', -4058, null)
    await pending
    expect(tar.x).toHaveBeenCalledExactlyOnceWith({
      file: archive, cwd: target, preserveOwner: false, unlink: false,
    })
  })

  it.each(['EACCES', 'EPERM'])('does not fall back on %s startup errors', async (code) => {
    const pending = extractTarGzipArchive(archive, target)
    child.emit('error', Object.assign(new Error(code), { code }))
    await expect(pending).rejects.toThrow(`Windows tar.exe failed to start: ${code}`)
    expect(tar.x).not.toHaveBeenCalled()
  })

  it('preserves native extraction errors without retrying over partial output', async () => {
    const pending = extractTarGzipArchive(archive, target)
    child.stderr.emit('data', Buffer.from('invalid archive'))
    child.emit('close', 1, null)
    await expect(pending).rejects.toThrow('failed to extract Runtime archive: invalid archive')
    expect(tar.x).not.toHaveBeenCalled()
  })

  it('does not fall back when the native extractor is terminated', async () => {
    const pending = extractTarGzipArchive(archive, target)
    child.emit('close', null, 'SIGTERM')
    await expect(pending).rejects.toThrow('signal SIGTERM')
    expect(tar.x).not.toHaveBeenCalled()
  })

  it('propagates failures from the fallback extractor', async () => {
    vi.mocked(tar.x).mockRejectedValue(new Error('node extraction failed'))
    const pending = extractTarGzipArchive(archive, target)
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))
    await expect(pending).rejects.toThrow('node extraction failed')
  })

  it('uses Node tar directly on non-Windows platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await extractTarGzipArchive(archive, target)
    expect(spawn).not.toHaveBeenCalled()
    expect(tar.x).toHaveBeenCalledExactlyOnceWith({
      file: archive, cwd: target, preserveOwner: false, unlink: false,
    })
  })
})
