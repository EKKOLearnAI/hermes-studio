import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  isSqliteAvailable: () => Boolean(state.db),
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('workspace diff tracker', () => {
  let root: string
  let repo: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workspace-diff-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'diffs.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    writeFileSync(join(repo, 'dirty.txt'), 'committed\n')
    writeFileSync(join(repo, 'changed.txt'), 'old\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'initial'])
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('hides every Git subprocess window on Windows', () => {
    const source = readFileSync(
      'packages/server/src/services/hermes/run-chat/workspace-diff-tracker.ts',
      'utf8',
    )

    expect(source.match(/execFileSync\('git'/g)).toHaveLength(4)
    expect(source.match(/windowsHide: true/g)).toHaveLength(4)
  })

  it('records only files changed during the run when the repo was already dirty', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    writeFileSync(join(repo, 'dirty.txt'), 'preexisting dirty change\n')
    startWorkspaceRunCheckpoint({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: repo,
    })

    writeFileSync(join(repo, 'changed.txt'), 'new\n')
    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: repo,
    })

    expect(change).not.toBeNull()
    expect(change?.change_id).toMatch(/^run:run-1:/)
    expect(change?.files.map(file => file.path)).toEqual(['changed.txt'])
    expect(change?.files[0]).toMatchObject({
      change_type: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    })
    expect(change?.files[0].patch).toBeUndefined()

    const { getWorkspaceRunChangeFile, listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')
    const detail = getWorkspaceRunChangeFile('session-1', change!.change_id, change!.files[0].id)
    expect(detail?.patch).toContain('-old')
    expect(detail?.patch).toContain('+new')

    startWorkspaceRunCheckpoint({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: repo,
    })
    writeFileSync(join(repo, 'changed.txt'), 'newer\n')
    const secondChange = completeWorkspaceRunCheckpoint({
      sessionId: 'session-1',
      runId: 'run-1',
      workspace: repo,
    })

    expect(secondChange).not.toBeNull()
    expect(secondChange?.change_id).toMatch(/^run:run-1:/)
    expect(secondChange?.change_id).not.toBe(change?.change_id)

    const savedChanges = listWorkspaceRunChangesForSession('session-1')
    expect(savedChanges).toHaveLength(2)
    expect(savedChanges.map(saved => saved.change_id)).toEqual(expect.arrayContaining([
      change!.change_id,
      secondChange!.change_id,
    ]))
  })

  it('records added, modified, and deleted files in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'deleted.txt'), 'remove me\n')
    writeFileSync(join(workspace, 'old.txt'), 'old\n')
    writeFileSync(join(workspace, 'unchanged.txt'), 'same\n')

    startWorkspaceRunCheckpoint({
      sessionId: 'session-plain',
      runId: 'run-plain',
      workspace,
    })

    rmSync(join(workspace, 'deleted.txt'))
    writeFileSync(join(workspace, 'added.txt'), 'added\n')
    writeFileSync(join(workspace, 'old.txt'), 'new\n')
    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-plain',
      runId: 'run-plain',
      workspace,
    })

    expect(change).not.toBeNull()
    expect(change?.workspace_kind).toBe('filesystem')
    expect(change?.files.map(file => file.path)).toEqual(['added.txt', 'deleted.txt', 'old.txt'])
    expect(change?.files.map(file => [file.path, file.change_type])).toEqual([
      ['added.txt', 'added'],
      ['deleted.txt', 'deleted'],
      ['old.txt', 'modified'],
    ])

    const { getWorkspaceRunChangeFile } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')
    const modified = change!.files.find(file => file.path === 'old.txt')!
    const detail = getWorkspaceRunChangeFile('session-plain', change!.change_id, modified.id)
    expect(detail?.patch).toContain('-old')
    expect(detail?.patch).toContain('+new')
  })

  it('skips empty zero-byte file changes in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-empty-file')
    mkdirSync(workspace)

    startWorkspaceRunCheckpoint({
      sessionId: 'session-empty',
      runId: 'run-empty',
      workspace,
    })

    writeFileSync(join(workspace, 'empty.txt'), '')
    const emptyOnlyChange = completeWorkspaceRunCheckpoint({
      sessionId: 'session-empty',
      runId: 'run-empty',
      workspace,
    })

    expect(emptyOnlyChange).toBeNull()

    startWorkspaceRunCheckpoint({
      sessionId: 'session-empty',
      runId: 'run-non-empty',
      workspace,
    })

    writeFileSync(join(workspace, 'non-empty.txt'), 'content\n')
    const nonEmptyChange = completeWorkspaceRunCheckpoint({
      sessionId: 'session-empty',
      runId: 'run-non-empty',
      workspace,
    })

    expect(nonEmptyChange).not.toBeNull()
    expect(nonEmptyChange?.files.map(file => file.path)).toEqual(['non-empty.txt'])
  })

  it('does not save zero-line diffs that are not covered by filename filters', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-zero-line-diff')
    mkdirSync(workspace)
    writeFileSync(join(workspace, '.global-cache'), Buffer.from([0, 1, 2, 3]))

    startWorkspaceRunCheckpoint({
      sessionId: 'session-zero-line',
      runId: 'run-zero-line',
      workspace,
    })

    writeFileSync(join(workspace, '.global-cache'), Buffer.from([0, 4, 5, 6]))
    writeFileSync(join(workspace, 'notes.md'), 'visible change\n')
    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-zero-line',
      runId: 'run-zero-line',
      workspace,
    })

    expect(change).not.toBeNull()
    expect(change?.files.map(file => file.path)).toEqual(['notes.md'])
    expect(state.db?.prepare('SELECT COUNT(*) AS count FROM workspace_run_change_files WHERE additions = 0 AND deletions = 0').get()).toEqual({ count: 0 })
  })

  it('skips SQLite WAL and SHM sidecar files in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-sqlite-sidecars')
    mkdirSync(workspace)

    startWorkspaceRunCheckpoint({
      sessionId: 'session-sqlite-sidecars',
      runId: 'run-sqlite-sidecars',
      workspace,
    })

    writeFileSync(join(workspace, 'state.db-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'state.db-shm'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'cache.sqlite-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'cache.sqlite-shm'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'notes.md'), 'visible change\n')

    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-sqlite-sidecars',
      runId: 'run-sqlite-sidecars',
      workspace,
    })

    expect(change).not.toBeNull()
    expect(change?.files.map(file => file.path)).toEqual(['notes.md'])
  })

  it('skips SQLite WAL and SHM sidecar files in git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    startWorkspaceRunCheckpoint({
      sessionId: 'session-git-sqlite-sidecars',
      runId: 'run-git-sqlite-sidecars',
      workspace: repo,
    })

    writeFileSync(join(repo, 'state.db-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(repo, 'state.db-shm'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(repo, 'cache.sqlite-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(repo, 'cache.sqlite-shm'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(repo, 'notes.md'), 'visible change\n')

    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-git-sqlite-sidecars',
      runId: 'run-git-sqlite-sidecars',
      workspace: repo,
    })

    expect(change).not.toBeNull()
    expect(change?.files.map(file => file.path)).toEqual(['notes.md'])
  })

  it('records newly created ordinary files even when many unchanged files already exist in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-many-existing-files')
    mkdirSync(workspace)
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(workspace, `existing-${index.toString().padStart(3, '0')}.txt`), 'unchanged\n')
    }

    startWorkspaceRunCheckpoint({
      sessionId: 'session-many-existing-files',
      runId: 'run-many-existing-files',
      workspace,
    })

    writeFileSync(join(workspace, 'README-visible.md'), '# visible new file\n')
    writeFileSync(join(workspace, 'notes-visible.txt'), 'plain text visible\n')
    writeFileSync(join(workspace, 'config-visible.json'), '{"visible": true}\n')
    writeFileSync(join(workspace, 'state.db-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'state.db-shm'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'cache.sqlite-wal'), Buffer.alloc(32 * 1024, 0))
    writeFileSync(join(workspace, 'cache.sqlite-shm'), Buffer.alloc(32 * 1024, 0))

    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-many-existing-files',
      runId: 'run-many-existing-files',
      workspace,
    })

    expect(change).not.toBeNull()
    expect(change?.files).toHaveLength(3)
    expect(change?.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'README-visible.md',
      'config-visible.json',
      'notes-visible.txt',
    ]))
  })

  it('skips common language dependency and build directories in non-git workspaces', async () => {
    const {
      completeWorkspaceRunCheckpoint,
      startWorkspaceRunCheckpoint,
    } = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')

    const workspace = join(root, 'plain-with-language-artifacts')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'node_modules'), { recursive: true })
    mkdirSync(join(workspace, '__pycache__'), { recursive: true })
    mkdirSync(join(workspace, 'target'), { recursive: true })
    mkdirSync(join(workspace, 'vendor'), { recursive: true })
    mkdirSync(join(workspace, '.terraform'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'app.py'), 'old\n')
    writeFileSync(join(workspace, 'node_modules', 'ignored.js'), 'before\n')
    writeFileSync(join(workspace, '__pycache__', 'ignored.pyc'), 'before\n')
    writeFileSync(join(workspace, 'target', 'ignored.class'), 'before\n')
    writeFileSync(join(workspace, 'vendor', 'ignored.php'), 'before\n')
    writeFileSync(join(workspace, '.terraform', 'ignored.tfstate'), 'before\n')

    startWorkspaceRunCheckpoint({
      sessionId: 'session-ignore',
      runId: 'run-ignore',
      workspace,
    })

    writeFileSync(join(workspace, 'src', 'app.py'), 'new\n')
    writeFileSync(join(workspace, 'node_modules', 'ignored.js'), 'after\n')
    writeFileSync(join(workspace, '__pycache__', 'ignored.pyc'), 'after\n')
    writeFileSync(join(workspace, 'target', 'ignored.class'), 'after\n')
    writeFileSync(join(workspace, 'vendor', 'ignored.php'), 'after\n')
    writeFileSync(join(workspace, '.terraform', 'ignored.tfstate'), 'after\n')
    const change = completeWorkspaceRunCheckpoint({
      sessionId: 'session-ignore',
      runId: 'run-ignore',
      workspace,
    })

    expect(change).not.toBeNull()
    expect(change?.files.map(file => file.path)).toEqual(['src/app.py'])
  })
})
