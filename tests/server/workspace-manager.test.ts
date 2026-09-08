import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveWorkspacePath,
  selectWorkspace,
} from '../../packages/server/src/modules/studio/services/workspace/manager'

describe('Studio workspace manager', () => {
  let root: string
  let workspace: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-workspace-manager-'))
    workspace = join(root, 'workspace')
    outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, 'shared.txt'), 'shared')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('selects the first non-empty workspace consistently', () => {
    const unusedFallback = vi.fn(() => outside)
    expect(selectWorkspace(null, '  ', `  ${workspace}  `, unusedFallback)).toBe(workspace)
    expect(unusedFallback).not.toHaveBeenCalled()
  })

  it('allows local administrator paths outside the selected workspace', async () => {
    await expect(resolveWorkspacePath(workspace, '../outside/shared.txt', {
      access: 'unrestricted',
    })).resolves.toEqual({
      workspace,
      relativePath: '../outside/shared.txt',
      fullPath: join(outside, 'shared.txt'),
    })
  })

  it('keeps capability-scoped remote paths contained', async () => {
    await expect(resolveWorkspacePath(workspace, '../outside/shared.txt')).rejects.toMatchObject({
      code: 'invalid_path',
      status: 400,
    })

    await symlink(join(outside, 'shared.txt'), join(workspace, 'escaped.txt'))
    await expect(resolveWorkspacePath(workspace, 'escaped.txt')).rejects.toMatchObject({
      code: 'invalid_path',
      status: 400,
    })
  })
})
