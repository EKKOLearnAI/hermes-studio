import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWorkspaceRunCheckpointMemoryForTest,
  completeWorkspaceRunCheckpointDraft,
  startWorkspaceRunCheckpoint,
} from '../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('durable workspace run checkpoints', () => {
  it('restores baseline evidence from disk after in-memory ownership is lost', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-checkpoint-recovery-'))
    tempDirs.push(workspace)
    const file = join(workspace, 'result.txt')
    writeFileSync(file, 'before\n')
    const sessionId = `checkpoint-session-${Date.now()}`
    const runId = `checkpoint-run-${Date.now()}`

    const checkpointRef = startWorkspaceRunCheckpoint({ sessionId, runId, workspace })
    expect(checkpointRef).toBeTruthy()
    writeFileSync(file, 'after\n')
    clearWorkspaceRunCheckpointMemoryForTest()

    const draft = completeWorkspaceRunCheckpointDraft({ sessionId, runId, workspace })
    expect(draft).toMatchObject({
      session_id: sessionId,
      run_id: runId,
      files_changed: 1,
      files: [expect.objectContaining({ path: 'result.txt', change_type: 'modified' })],
    })
  })
})
