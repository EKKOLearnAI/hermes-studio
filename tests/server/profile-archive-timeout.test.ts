import { existsSync } from 'fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermesWithBin: execMock,
  spawnHermesWithBin: vi.fn(),
  resolveHermesBin: () => 'hermes',
}))

describe('profile archive timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gives the archive ten minutes, not one', async () => {
    execMock.mockResolvedValue({ stdout: 'exported', stderr: '' })
    const { exportProfile } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await exportProfile('mohamed', '/tmp/hermes-profile-mohamed.tar.gz')

    const [, args, options] = execMock.mock.calls[0]
    expect(args).toEqual(['profile', 'export', 'mohamed', '--output', '/tmp/hermes-profile-mohamed.tar.gz'])
    expect(options.timeout).toBe(10 * 60 * 1000)
    expect(options.env.TMPDIR).toBe(options.env.TMP)
    expect(options.env.TMPDIR).toBe(options.env.TEMP)
    expect(existsSync(options.env.TMPDIR)).toBe(false)
  })

  it('reports a killed export as a timeout rather than a bare "Command failed"', async () => {
    // execFile kills on timeout: killed === true, empty stderr, opaque message
    execMock.mockRejectedValue(Object.assign(
      new Error('Command failed: /opt/hermes/venv/bin/hermes profile export mohamed --output /tmp/x.tar.gz\n'),
      { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' },
    ))
    const { exportProfile, ARCHIVE_TIMEOUT_CODE } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await expect(exportProfile('mohamed')).rejects.toMatchObject({
      code: ARCHIVE_TIMEOUT_CODE,
      message: expect.stringContaining('timed out after 10 minutes'),
    })
    const tempDirectory = execMock.mock.calls[0][2].env.TMPDIR
    expect(existsSync(tempDirectory)).toBe(false)
  })

  it('gives an import the same ten minutes', async () => {
    execMock.mockResolvedValue({ stdout: 'imported', stderr: '' })
    const { importProfile } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await importProfile('/tmp/hermes-import/hermes-profile-mohamed.tar.gz')

    const [, args, options] = execMock.mock.calls[0]
    expect(args[1]).toBe('import')
    expect(options.timeout).toBe(10 * 60 * 1000)
  })

  it('reports a killed import as a timeout too', async () => {
    execMock.mockRejectedValue(Object.assign(
      new Error('Command failed: hermes profile import /tmp/big.tar.gz\n'),
      { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' },
    ))
    const { importProfile, ARCHIVE_TIMEOUT_CODE } = await import('../../packages/server/src/services/hermes/hermes-cli')

    await expect(importProfile('/tmp/big.tar.gz')).rejects.toMatchObject({
      code: ARCHIVE_TIMEOUT_CODE,
      message: expect.stringContaining('timed out after 10 minutes'),
    })
  })

  it('keeps a genuine export failure distinguishable from a timeout', async () => {
    execMock.mockRejectedValue(Object.assign(
      new Error('Command failed: hermes profile export ghost'),
      { code: 1, stdout: '', stderr: "profile 'ghost' not found" },
    ))
    const { exportProfile, ARCHIVE_TIMEOUT_CODE } = await import('../../packages/server/src/services/hermes/hermes-cli')

    const err = await exportProfile('ghost').catch(e => e)
    expect(err.code).not.toBe(ARCHIVE_TIMEOUT_CODE)
    expect(err.message).toContain('Failed to export profile')
  })
})
