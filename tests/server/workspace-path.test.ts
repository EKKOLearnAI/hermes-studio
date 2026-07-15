import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('workspace path validation', () => {
  let root: string
  let originalWorkspaceBase: string | undefined

  beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'hermes-workspace-path-'))
    originalWorkspaceBase = process.env.WORKSPACE_BASE
    process.env.WORKSPACE_BASE = root
  })

  afterEach(async () => {
    if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
    else process.env.WORKSPACE_BASE = originalWorkspaceBase
    await rm(root, { recursive: true, force: true })
  })

  it('resolves valid folders under the configured base', async () => {
    const folder = join(root, 'project')
    await mkdir(folder)
    const { resolveAllowedWorkspaceFolder } = await import('../../packages/server/src/services/hermes/workspace-path')

    await expect(resolveAllowedWorkspaceFolder('project')).resolves.toEqual({ base: root, fullPath: folder })
    await expect(resolveAllowedWorkspaceFolder(folder)).resolves.toEqual({ base: root, fullPath: folder })
  })

  it('rejects traversal outside the base', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hermes-workspace-path-outside-'))
    const { resolveAllowedWorkspaceFolder, assertAllowedWorkspaceFolder } = await import('../../packages/server/src/services/hermes/workspace-path')

    await expect(resolveAllowedWorkspaceFolder(outside)).resolves.toBeNull()
    await expect(assertAllowedWorkspaceFolder(outside)).rejects.toMatchObject({ status: 403 })
    await rm(outside, { recursive: true, force: true })
  })

  it('rejects files and empty strings as workspace folders', async () => {
    await writeFile(join(root, 'file.txt'), 'not a folder')
    const { resolveAllowedWorkspaceFolder, assertAllowedWorkspaceFolder } = await import('../../packages/server/src/services/hermes/workspace-path')

    await expect(resolveAllowedWorkspaceFolder('file.txt')).resolves.toBeNull()
    await expect(resolveAllowedWorkspaceFolder('')).resolves.toBeNull()
    await expect(assertAllowedWorkspaceFolder('')).rejects.toMatchObject({ status: 400 })
  })

  it('normalizes native Windows drive paths when drive mode is active', async () => {
    const originalPlatform = process.platform
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.WORKSPACE_BASE
    try {
      const { normalizeWindowsWorkspacePath } = await import('../../packages/server/src/services/hermes/workspace-path')
      expect(normalizeWindowsWorkspacePath('c:/Users/Alice/Project')).toEqual({
        base: 'C:\\',
        fullPath: 'c:\\Users\\Alice\\Project',
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
    }
  })

  it('requires realpath containment on Windows when WORKSPACE_BASE is configured', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { isWorkspaceListPathAllowed } = await import('../../packages/server/src/services/hermes/workspace-path')
      const directoryStat = async () => ({ isDirectory: () => true }) as any
      const escapedViaJunction = vi.fn(async () => false)
      const withinBase = vi.fn(async () => true)

      await expect(isWorkspaceListPathAllowed('C:\\base\\link', 'C:\\base', directoryStat, { realPathWithinFn: escapedViaJunction })).resolves.toBe(false)
      expect(escapedViaJunction).toHaveBeenCalledWith('C:\\base\\link', 'C:\\base')
      await expect(isWorkspaceListPathAllowed('C:\\base\\link', 'C:\\base', directoryStat, { trustWindowsJunctions: true, realPathWithinFn: escapedViaJunction })).resolves.toBe(false)

      await expect(isWorkspaceListPathAllowed('C:\\base\\project', 'C:\\base', directoryStat, { realPathWithinFn: withinBase })).resolves.toBe(true)
      expect(withinBase).toHaveBeenCalledWith('C:\\base\\project', 'C:\\base')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('keeps Windows drive-root mode listable without a configured base', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { isWorkspaceListPathAllowed } = await import('../../packages/server/src/services/hermes/workspace-path')
      const directoryStat = async () => ({ isDirectory: () => true }) as any
      const realPathWithinFn = vi.fn(async () => false)

      await expect(isWorkspaceListPathAllowed('C:\\Users\\Alice', 'C:\\', directoryStat, { trustWindowsDriveRoot: true, realPathWithinFn })).resolves.toBe(true)
      expect(realPathWithinFn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
