import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decorateWorkspaceEntries,
  getWorkspaceFileGitDiff,
  parseWorkspaceGitStatus,
} from '../../packages/server/src/services/hermes/workspace-git-status'

describe('workspace git status', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('parses modified, new, renamed, deleted, and conflicted porcelain entries', () => {
    const output = [
      ' M src/modified.ts',
      '?? src/untracked.ts',
      'A  src/added.ts',
      ' D src/deleted.ts',
      'R  src/renamed.ts',
      'src/original.ts',
      'UU src/conflicted.ts',
      '',
    ].join('\0')

    expect(parseWorkspaceGitStatus(output)).toEqual([
      { path: 'src/modified.ts', status: 'modified' },
      { path: 'src/untracked.ts', status: 'untracked' },
      { path: 'src/added.ts', status: 'added' },
      { path: 'src/deleted.ts', status: 'deleted' },
      { path: 'src/renamed.ts', status: 'renamed' },
      { path: 'src/original.ts', status: 'deleted' },
      { path: 'src/conflicted.ts', status: 'conflicted' },
    ])
  })

  it('decorates files and aggregates descendant changes onto directories', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'hermes-workspace-git-'))
    tempDirs.push(repository)
    const workspace = join(repository, 'packages', 'app')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'tracked.ts'), 'before\n')
    await writeFile(join(workspace, 'clean.ts'), 'clean\n')

    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Hermes Test'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'hermes@example.com'], { cwd: repository })
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repository })

    await writeFile(join(workspace, 'src', 'tracked.ts'), 'after\n')
    await mkdir(join(workspace, 'generated'), { recursive: true })
    await writeFile(join(workspace, 'generated', 'new.ts'), 'new\n')
    await writeFile(join(workspace, 'staged.ts'), 'staged\n')
    execFileSync('git', ['add', 'packages/app/staged.ts'], { cwd: repository })

    const result = await decorateWorkspaceEntries(workspace, '', [
      { path: 'src', isDir: true },
      { path: 'generated', isDir: true },
      { path: 'staged.ts', isDir: false },
      { path: 'clean.ts', isDir: false },
    ])

    expect(result.entries).toEqual([
      { path: 'src', isDir: true, gitStatus: 'modified', gitStatusCount: 1 },
      { path: 'generated', isDir: true, gitStatus: 'untracked', gitStatusCount: 1 },
      { path: 'staged.ts', isDir: false, gitStatus: 'added', gitStatusCount: 1 },
      { path: 'clean.ts', isDir: false },
    ])
    expect(result.directoryDecoration).toEqual({ gitStatus: 'modified', gitStatusCount: 3 })
  })

  it('returns undecorated entries outside a git repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hermes-workspace-no-git-'))
    tempDirs.push(workspace)

    await expect(decorateWorkspaceEntries(workspace, '', [
      { path: 'notes.txt', isDir: false },
    ])).resolves.toEqual({
      entries: [{ path: 'notes.txt', isDir: false }],
      directoryDecoration: undefined,
    })
  })

  it('discovers child repositories in a multi-repository workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hermes-workspace-multi-git-'))
    tempDirs.push(workspace)
    const repository = join(workspace, 'studio')
    await mkdir(repository)
    await writeFile(join(repository, 'tracked.ts'), 'before\n')
    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Hermes Test'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'hermes@example.com'], { cwd: repository })
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repository })
    await writeFile(join(repository, 'tracked.ts'), 'after\n')

    const rootResult = await decorateWorkspaceEntries(workspace, '', [
      { path: 'studio', isDir: true },
    ])
    const repositoryResult = await decorateWorkspaceEntries(workspace, 'studio', [
      { path: 'studio/tracked.ts', isDir: false },
    ])

    expect(rootResult.entries[0]).toMatchObject({ gitStatus: 'modified', gitStatusCount: 1 })
    expect(repositoryResult.entries[0]).toMatchObject({ gitStatus: 'modified', gitStatusCount: 1 })
  })

  it('returns the current diff for tracked and untracked workspace files', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'hermes-workspace-file-diff-'))
    tempDirs.push(repository)
    await writeFile(join(repository, 'tracked.ts'), 'before\n')
    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Hermes Test'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'hermes@example.com'], { cwd: repository })
    execFileSync('git', ['add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repository })

    await writeFile(join(repository, 'tracked.ts'), 'after\n')
    await writeFile(join(repository, 'untracked.ts'), 'new line\n')

    const tracked = await getWorkspaceFileGitDiff(repository, 'tracked.ts')
    expect(tracked).toMatchObject({
      path: 'tracked.ts',
      gitStatus: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    })
    expect(tracked.patch).toContain('-before')
    expect(tracked.patch).toContain('+after')

    const untracked = await getWorkspaceFileGitDiff(repository, 'untracked.ts')
    expect(untracked).toMatchObject({
      path: 'untracked.ts',
      gitStatus: 'untracked',
      additions: 1,
      deletions: 0,
      binary: false,
    })
    expect(untracked.patch).toContain('+++ b/untracked.ts')
    expect(untracked.patch).toContain('+new line')
  })
})
