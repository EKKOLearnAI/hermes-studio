import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server as HttpServer } from 'http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbState = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  isSqliteAvailable: () => Boolean(dbState.db),
}))

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    id: 'agent-socket',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

describe('group chat workspace diff persistence', () => {
  let root: string
  let workspace: string
  let httpServer: HttpServer

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-gc-diff-'))
    workspace = join(root, 'workspace')
    mkdirSync(workspace)
    dbState.db = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    httpServer = createServer()
  })

  afterEach(() => {
    httpServer?.close()
    dbState.db?.close()
    dbState.db = null
    rmSync(root, { recursive: true, force: true })
  })

  async function makeDraft(runId = '0123456789abcdef0123456789abcdef') {
    const tracker = await import('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker')
    writeFileSync(join(workspace, 'file.txt'), 'old\n')
    tracker.startWorkspaceRunCheckpoint({ sessionId: 'session-1', runId, workspace })
    writeFileSync(join(workspace, 'file.txt'), 'new\n')
    return tracker.completeWorkspaceRunCheckpointDraft({ sessionId: 'session-1', runId, workspace })
  }

  async function saveDiff(storage: any, roomId = 'room-1', runId = '0123456789abcdef0123456789abcdef') {
    const draft = await makeDraft(runId)
    const saved = storage.saveWorkspaceDiffMessageForRun({
      roomId,
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId,
      status: 'completed',
      workspace,
      draft: draft!,
    })
    return { saved, payload: JSON.parse(saved!.message.content) }
  }

  function countRows(table: string, where = '', ...args: unknown[]): number {
    return (dbState.db?.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...args) as { count: number }).count
  }

  function expectWorkspaceChangeDeleted(changeId: string) {
    expect(countRows('workspace_run_changes', ' WHERE change_id = ?', changeId)).toBe(0)
    expect(countRows('workspace_run_change_files', ' WHERE change_id = ?', changeId)).toBe(0)
  }

  it('persists one workspace_run_change and one durable workspace_diff group message', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const runId = '0123456789abcdef0123456789abcdef'
    const draft = await makeDraft(runId)

    const saved = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId,
      status: 'completed',
      workspace,
      draft: draft!,
    })

    expect(saved?.message).toMatchObject({
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: `workspace_diff:${runId}`,
      senderId: 'agent-1',
      senderName: 'Worker',
    })
    const payload = JSON.parse(saved!.message.content)
    expect(payload).toMatchObject({
      kind: 'workspace_diff',
      version: 1,
      room_id: 'room-1',
      session_id: 'session-1',
      run_id: runId,
      status: 'completed',
      files_changed: 1,
    })
    expect(payload.files[0].patch).toContain('-old')
    expect(payload.files[0].patch).toContain('+new')
    expect(payload.workspace).toBeUndefined()
    expect(payload.workspace_basename).toBe('workspace')

    const rows = dbState.db?.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE tool_name = ?').get('workspace_diff') as { count: number }
    expect(rows.count).toBe(1)
    const changeRow = dbState.db?.prepare('SELECT workspace, room_id, message_id FROM workspace_run_changes WHERE change_id = ?').get(payload.change_id) as { workspace: string; room_id: string; message_id: string }
    expect(changeRow.workspace).toBe('workspace')
    expect(changeRow.workspace).not.toBe(workspace)
    expect(changeRow.room_id).toBe('room-1')
    expect(changeRow.message_id).toBe(saved!.message.id)
    const changeRows = dbState.db?.prepare('SELECT COUNT(*) AS count FROM workspace_run_changes WHERE change_id = ?').get(payload.change_id) as { count: number }
    expect(changeRows.count).toBe(1)
    server.getIO().close()
  })

  it('keeps workspace_diff message ids unique when room ids are long', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    const roomId = `room-${'x'.repeat(220)}`
    storage.saveRoom(roomId, 'Long Room')
    const runA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const runB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    const draftA = await makeDraft(runA)
    const savedA = storage.saveWorkspaceDiffMessageForRun({
      roomId,
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId: runA,
      status: 'completed',
      workspace,
      draft: draftA!,
    })
    const draftB = await makeDraft(runB)
    const savedB = storage.saveWorkspaceDiffMessageForRun({
      roomId,
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId: runB,
      status: 'completed',
      workspace,
      draft: draftB!,
    })

    expect(savedA?.message.id).not.toBe(savedB?.message.id)
    expect(savedA?.message.id).toContain(runA)
    expect(savedB?.message.id).toContain(runB)
    const rows = dbState.db?.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE roomId = ? AND tool_name = ?').get(roomId, 'workspace_diff') as { count: number }
    expect(rows.count).toBe(2)
    server.getIO().close()
  })

  it('cleans persisted workspace diffs when room context is cleared', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const { payload } = await saveDiff(storage)

    expect(countRows('workspace_run_changes', ' WHERE change_id = ?', payload.change_id)).toBe(1)
    storage.clearRoomContext('room-1')

    expectWorkspaceChangeDeleted(payload.change_id)
    expect(countRows('gc_messages', ' WHERE roomId = ?', 'room-1')).toBe(0)
    server.getIO().close()
  })

  it('does not delete unrelated workspace changes from spoofed workspace_diff message content', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    storage.saveRoom('room-2', 'Room 2')
    const { payload } = await saveDiff(storage, 'room-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

    storage.saveMessageAndRefreshRoom({
      id: 'fake-workspace-diff',
      roomId: 'room-2',
      senderId: 'user-2',
      senderName: 'Mallory',
      content: JSON.stringify({ kind: 'workspace_diff', change_id: payload.change_id }),
      timestamp: 1,
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: 'workspace_diff:fake',
    })
    storage.clearRoomContext('room-2')

    expect(countRows('workspace_run_changes', ' WHERE change_id = ?', payload.change_id)).toBe(1)
    expect(countRows('workspace_run_change_files', ' WHERE change_id = ?', payload.change_id)).toBeGreaterThan(0)
    server.getIO().close()
  })

  it('does not allow client messages to overwrite server-created workspace diff cards', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const { saved, payload } = await saveDiff(storage, 'room-1', 'cccccccccccccccccccccccccccccccc')
    const originalTimestamp = saved!.message.timestamp

    const overwrite = storage.saveMessageAndRefreshRoom({
      id: saved!.message.id,
      roomId: 'room-1',
      senderId: 'user-1',
      senderName: 'Mallory',
      content: JSON.stringify({ kind: 'workspace_diff', change_id: 'other-change' }),
      timestamp: 1,
      role: 'tool',
      tool_name: 'workspace_diff',
      tool_call_id: 'workspace_diff:fake',
    })

    expect(overwrite.message.timestamp).toBe(originalTimestamp)
    expect(JSON.parse(String(overwrite.message.content)).change_id).toBe(payload.change_id)
    expect(countRows('workspace_run_changes', ' WHERE change_id = ?', payload.change_id)).toBe(1)
    server.getIO().close()
  })

  it('cleans persisted workspace diffs when a room is deleted', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const { payload } = await saveDiff(storage, 'room-1', 'dddddddddddddddddddddddddddddddd')

    storage.deleteRoom('room-1')

    expectWorkspaceChangeDeleted(payload.change_id)
    expect(countRows('gc_messages', ' WHERE roomId = ?', 'room-1')).toBe(0)
    expect(countRows('gc_rooms', ' WHERE id = ?', 'room-1')).toBe(0)
    server.getIO().close()
  })

  it('does not write workspace diff rows after a room is deleted', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const draft = await makeDraft('99999999999999999999999999999999')

    storage.deleteRoom('room-1')
    const saved = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId: '99999999999999999999999999999999',
      status: 'completed',
      workspace,
      draft: draft!,
    })

    expect(saved).toBeNull()
    expect(countRows('gc_messages', ' WHERE roomId = ?', 'room-1')).toBe(0)
    expect(countRows('workspace_run_changes')).toBe(0)
    expect(countRows('workspace_run_change_files')).toBe(0)
    server.getIO().close()
  })

  it('cleans persisted workspace diffs when their group messages are pruned', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const { saved, payload } = await saveDiff(storage, 'room-1', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    dbState.db?.prepare('UPDATE gc_messages SET timestamp = ? WHERE id = ?').run(1, saved!.message.id)
    storage.saveMessageAndRefreshRoom({
      id: 'keep-message',
      roomId: 'room-1',
      senderId: 'user-1',
      senderName: 'User',
      content: 'keep',
      timestamp: 100,
      role: 'user',
    })

    storage.pruneMessages('room-1', 1)

    expectWorkspaceChangeDeleted(payload.change_id)
    expect(countRows('gc_messages', ' WHERE id = ?', saved!.message.id)).toBe(0)
    expect(countRows('gc_messages', ' WHERE id = ?', 'keep-message')).toBe(1)
    server.getIO().close()
  })

  it('rolls back diff rows when the group message insert fails', async () => {
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    const server = new GroupChatServer(httpServer)
    const storage = server.getStorage()
    storage.saveRoom('room-1', 'Room 1')
    const draft = await makeDraft('fedcba9876543210fedcba9876543210')
    dbState.db?.exec(`CREATE TRIGGER fail_workspace_diff_message
      BEFORE INSERT ON gc_messages
      WHEN NEW.tool_name = 'workspace_diff'
      BEGIN
        SELECT RAISE(ABORT, 'message failed');
      END`)

    expect(() => storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      sessionId: 'session-1',
      runId: 'fedcba9876543210fedcba9876543210',
      status: 'failed',
      workspace,
      draft: draft!,
    })).toThrow('message failed')

    expect((dbState.db?.prepare('SELECT COUNT(*) AS count FROM workspace_run_changes').get() as { count: number }).count).toBe(0)
    expect((dbState.db?.prepare('SELECT COUNT(*) AS count FROM workspace_run_change_files').get() as { count: number }).count).toBe(0)
    expect((dbState.db?.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE tool_name = ?').get('workspace_diff') as { count: number }).count).toBe(0)
    server.getIO().close()
  })
})
