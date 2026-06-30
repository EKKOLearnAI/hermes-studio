import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { mkdir, mkdtemp, rm, symlink } from 'fs/promises'
import { normalizePlatformPath, validatePath, resolveHermesPath } from '../../packages/server/src/services/hermes/file-provider'
import { isNearestExistingRealPathWithin, isPathWithin, isRealPathWithin, relativePathFromBase } from '../../packages/server/src/services/hermes/hermes-path'

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => '/tmp/hermes-test-home',
  getActiveEnvPath: () => '/tmp/hermes-test-home/.env',
  getProfileDir: (name: string) => `/tmp/hermes-test-home-${name}`,
}))

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

describe('resolveHermesPath path validation', () => {
  it('resolves absolute path within homeDir correctly', () => {
    const result = resolveHermesPath('/tmp/hermes-test-home/subdir/file.txt')
    expect(result).toBe('/tmp/hermes-test-home/subdir/file.txt')
  })

  it('rejects absolute path outside homeDir', () => {
    expect(() => resolveHermesPath('/etc/passwd')).toThrow('Path traversal detected')
  })

  it('rejects exact ".." (traversal)', () => {
    expect(() => resolveHermesPath('..')).toThrow('Invalid file path')
  })

  it('rejects "../foo" (traversal)', () => {
    expect(() => resolveHermesPath('../foo')).toThrow('Invalid file path')
  })

  it('allows "..hidden" filename (not traversal)', () => {
    const result = resolveHermesPath('..hidden')
    expect(result).toBe(resolve('/tmp/hermes-test-home', '..hidden'))
  })

  it('rejects mid-path traversal via /../', () => {
    expect(() => resolveHermesPath('subdir/../../../etc/passwd')).toThrow('Invalid file path')
  })

  it('resolves relative path normally', () => {
    const result = resolveHermesPath('docs/readme.md')
    expect(result).toBe(resolve('/tmp/hermes-test-home', 'docs/readme.md'))
  })
})

describe('Hermes path containment helpers', () => {
  it('does not treat sibling paths with the same prefix as inside the base', () => {
    expect(isPathWithin('/tmp/hermes-profile2/state.db', '/tmp/hermes-profile')).toBe(false)
    expect(isPathWithin('/tmp/hermes-profile/state.db', '/tmp/hermes-profile')).toBe(true)
  })

  it('allows filenames starting with double dots (not traversal)', () => {
    expect(isPathWithin('/tmp/hermes-profile/..hidden', '/tmp/hermes-profile')).toBe(true)
    expect(isPathWithin('/tmp/hermes-profile/...config', '/tmp/hermes-profile')).toBe(true)
  })

  it('rejects actual traversal via relative path', () => {
    expect(isPathWithin('/tmp/other/file.txt', '/tmp/hermes-profile')).toBe(false)
  })

  it('returns normalized relative paths only for children', () => {
    expect(relativePathFromBase('/tmp/hermes-profile/logs/run.txt', '/tmp/hermes-profile'))
      .toBe('logs/run.txt')
    expect(relativePathFromBase('/tmp/hermes-profile2/logs/run.txt', '/tmp/hermes-profile'))
      .toBeNull()
  })

  it('realpath-vets symlinked ancestors before allowing nested workspace operations', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'hermes-workspace-base-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'hermes-workspace-outside-'))

    try {
      const safeTarget = join(workspaceBase, 'projects')
      const safeLink = join(workspaceBase, 'linked-projects')
      const outsideTarget = join(outsideRoot, 'external-projects')
      const outsideLink = join(workspaceBase, 'linked-external')

      await mkdir(safeTarget, { recursive: true })
      await mkdir(outsideTarget, { recursive: true })
      await symlink(safeTarget, safeLink)
      await symlink(outsideTarget, outsideLink)

      await expect(isRealPathWithin(safeLink, workspaceBase)).resolves.toBe(true)
      await expect(isRealPathWithin(outsideLink, workspaceBase)).resolves.toBe(false)
      await expect(isNearestExistingRealPathWithin(join(safeLink, 'child'), workspaceBase)).resolves.toBe(true)
      await expect(isNearestExistingRealPathWithin(join(outsideLink, 'child'), workspaceBase)).resolves.toBe(false)
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})
