import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
})
