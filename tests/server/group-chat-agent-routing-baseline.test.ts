import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  currentRoomAgentSessionId,
  createTestGroupChatServer,
  emitAck,
  seedAuthenticatedUser,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat durable handoff routing baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinHumanAndAgent() {
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent', agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(agent, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    return { human, agent }
  }

  function currentAgentSessionId() {
    return currentRoomAgentSessionId(groupServer, 'room-1', 'agent-worker', 'default', 'Worker')
  }

  it('durably routes human messages through the handoff outbox', async () => {
    const { human } = await joinHumanAndAgent()

    const first = await emitAck<any>(human, 'message', { roomId: 'room-1', id: 'human-msg-1', content: '@Worker hello' })
    const replay = await emitAck<any>(human, 'message', { roomId: 'room-1', id: 'human-msg-1', content: '@Worker hello' })

    expect(first).toEqual({ id: 'human-msg-1' })
    expect(replay).toEqual({ id: 'human-msg-1' })
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toContainEqual(expect.objectContaining({
      sourceMessageId: 'human-msg-1',
      targetAgentId: 'agent-worker',
      depth: 0,
      kind: 'mention',
    }))
  })

  it('does not create a durable handoff for read-only invite member messages', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'read-only-token') return { id: 2, username: 'bob', role: 'admin', profiles: [] } as any
      return null
    })
    seedAuthenticatedUser(harness.db, { id: 2, username: 'bob' })
    const human = await connectGroupChatClient(port, 'ignored-user', 'Bob', { token: 'read-only-token' })
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent', agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(agent, 'join', { roomId: 'room-1' })

    await emitAck(human, 'message', { roomId: 'room-1', id: 'readonly-msg-1', content: '@Worker hello' })

    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([])
  })

  it('rejects an agent message that omits provenance while its durable handoff is running', async () => {
    const { human, agent } = await joinHumanAndAgent()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'durable-msg-trigger', content: '@Worker hello' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    expect(running).toMatchObject({ targetAgentId: 'agent-worker', status: 'running' })

    const response = await emitAck<any>(agent, 'message', {
      roomId: 'room-1',
      id: 'omitted-durable-agent-message',
      content: 'must not publish',
      role: 'assistant',
      agentSessionId: currentAgentSessionId(),
    })

    expect(response).toEqual(expect.objectContaining({ error: expect.stringMatching(/provenance|handoff|lease/i) }))
    expect(groupServer.getStorage().getMessage('omitted-durable-agent-message')).toBeNull()
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken,
    })
  })

  it('rejects a command message that omits provenance while its durable handoff is running', async () => {
    const { human, agent } = await joinHumanAndAgent()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'durable-command-trigger', content: '@Worker run' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    const beforeRoom = groupServer.getStorage().getRoom('room-1')

    const response = await emitAck<any>(agent, 'message', {
      roomId: 'room-1',
      id: 'omitted-durable-command-message',
      content: 'must not execute',
      role: 'command',
      agentSessionId: currentAgentSessionId(),
    })

    expect(response).toEqual(expect.objectContaining({ error: expect.stringMatching(/provenance|handoff|lease/i) }))
    expect(groupServer.getStorage().getMessage('omitted-durable-command-message')).toBeNull()
    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({
      messageSeq: beforeRoom?.messageSeq,
      totalTokens: beforeRoom?.totalTokens,
    })
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken,
    })
  })

  it('persists durable workspace evidence under the participant session while preserving runtime checkpoint provenance', async () => {
    const { human } = await joinHumanAndAgent()
    const runtimeSessionId = currentAgentSessionId()
    expect(runtimeSessionId).toMatch(/^gc_h_[0-9a-f]{32}$/)
    const runId = 'durable-runtime-workspace-run'
    await emitAck(human, 'message', { roomId: 'room-1', id: 'durable-workspace-trigger', content: '@Worker update files' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    const participantSessionId = running.targetSessionId
    expect(participantSessionId).toMatch(/^gc_room-1_agent-worker_0$/)
    expect(running).toMatchObject({
      targetAgentId: 'agent-worker',
      targetSessionId: participantSessionId,
      status: 'running',
    })
    expect(groupServer.getStorage().isHandoffExecutionCurrent(
      running.id,
      running.leaseToken,
      'agent-worker',
      participantSessionId,
    )).toBe(true)

    const saved = groupServer.getStorage().saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-worker',
      senderName: 'Worker',
      sessionId: participantSessionId,
      runId,
      status: 'completed',
      workspace: '/workspace/project',
      sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken,
      draft: {
        change_id: 'durable-runtime-workspace-change',
        session_id: runtimeSessionId,
        run_id: runId,
        source: 'run',
        workspace: '/workspace/project',
        started_at: 1,
        finished_at: 2,
        files_changed: 1,
        additions: 1,
        deletions: 0,
        total_patch_bytes: 4,
        files: [{
          path: 'file.txt',
          change_type: 'modified',
          additions: 1,
          deletions: 0,
          size_before: 3,
          size_after: 4,
          patch: '+new',
          patch_bytes: 4,
          binary: false,
          truncated: false,
        }],
      },
    })

    expect(saved?.message).toMatchObject({ senderId: 'agent-worker', role: 'tool' })
    expect(JSON.parse(saved!.message.content)).toMatchObject({
      session_id: participantSessionId,
      run_id: runId,
      change_id: 'durable-runtime-workspace-change',
    })
    expect(harness.db.prepare('SELECT session_id, run_id FROM workspace_run_changes WHERE change_id = ?')
      .get('durable-runtime-workspace-change')).toEqual({
      session_id: runtimeSessionId,
      run_id: runId,
    })
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken, targetSessionId: participantSessionId,
    })
  })

  it('rejects replay of an existing workspace message id when durable provenance is omitted', async () => {
    const { human, agent } = await joinHumanAndAgent()
    const agentSessionId = currentAgentSessionId()
    const runId = 'prior-workspace-run'
    const prior = groupServer.getStorage().saveWorkspaceDiffMessageForRun({
      roomId: 'room-1',
      senderId: 'agent-worker',
      senderName: 'Worker',
      sessionId: agentSessionId,
      runId,
      status: 'completed',
      workspace: '/workspace/project',
      draft: {
        change_id: 'prior-workspace-change',
        session_id: agentSessionId,
        run_id: runId,
        source: 'run',
        workspace: '/workspace/project',
        started_at: 1,
        finished_at: 2,
        files_changed: 0,
        additions: 0,
        deletions: 0,
        total_patch_bytes: 0,
        files: [],
      },
    })
    expect(prior?.message.id).toBe('gcmsg_workspace_diff_room-1_prior-workspace-run')

    await emitAck(human, 'message', { roomId: 'room-1', id: 'durable-workspace-replay-trigger', content: '@Worker run' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    const beforeRoom = groupServer.getStorage().getRoom('room-1')

    const response = await emitAck<any>(agent, 'message', {
      roomId: 'room-1',
      id: prior!.message.id,
      content: prior!.message.content,
      role: 'tool',
      tool_name: 'workspace_diff',
      agentSessionId,
    })

    expect(response).toEqual(expect.objectContaining({ error: expect.stringMatching(/provenance|handoff|lease/i) }))
    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({
      messageSeq: beforeRoom?.messageSeq,
      totalTokens: beforeRoom?.totalTokens,
    })
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken,
    })

    const forgedCurrentProvenance = await emitAck<any>(agent, 'message', {
      roomId: 'room-1',
      id: prior!.message.id,
      content: prior!.message.content,
      timestamp: prior!.message.timestamp,
      role: 'tool',
      tool_name: 'workspace_diff',
      agentSessionId,
      sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken,
    })
    expect(forgedCurrentProvenance).toEqual(expect.objectContaining({
      error: expect.stringMatching(/conflict|provenance|handoff|lease/i),
    }))
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken,
    })
  })

  it('accepts a command message bound to its live durable provenance', async () => {
    const { human, agent } = await joinHumanAndAgent()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'durable-bound-command-trigger', content: '@Worker run' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]

    const accepted = await emitAck<any>(agent, 'message', {
      roomId: 'room-1',
      id: 'provenance-bound-command-message',
      content: 'authorized command trace',
      role: 'command',
      handoffChainId: running.chainId,
      handoffDepth: running.depth + 1,
      agentSessionId: currentAgentSessionId(),
      sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken,
    })
    expect(accepted).toEqual({ id: 'provenance-bound-command-message' })
    expect(groupServer.getStorage().getMessage('provenance-bound-command-message')).toMatchObject({
      role: 'command',
      sourceHandoffJobId: running.id,
    })
    expect(groupServer.getStorage().getMessage('provenance-bound-command-message')).not.toHaveProperty('sourceHandoffLeaseHash')
    expect(groupServer.getStorage().getMessage('provenance-bound-command-message')).not.toHaveProperty('sourceHandoffLeaseToken')
    const storedLease = harness.db.prepare('SELECT sourceHandoffLeaseHash FROM gc_messages WHERE id = ?')
      .get('provenance-bound-command-message') as { sourceHandoffLeaseHash: string }
    expect(storedLease.sourceHandoffLeaseHash).toMatch(/^[a-f0-9]{64}$/)
    expect(storedLease.sourceHandoffLeaseHash).not.toBe(running.leaseToken)
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'running', leaseToken: running.leaseToken,
    })
  })

  it('accepts an identical terminal final retry through the real socket after the durable job completed', async () => {
    groupServer.getStorage().addRoomAgent('room-1', 'agent-reviewer', 'default', 'Reviewer', '', 1)
    harness.db.prepare(
      "UPDATE gc_rooms SET handoffMode = 'fixed', handoffOrderJson = ? WHERE id = ?",
    ).run(JSON.stringify(['agent-worker', 'agent-reviewer']), 'room-1')
    const { human, agent } = await joinHumanAndAgent()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'terminal-retry-trigger', content: '@Worker answer' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    const payload = {
      roomId: 'room-1',
      id: 'terminal-retry-final',
      content: 'final answer',
      timestamp: 123456,
      role: 'assistant',
      handoffChainId: running.chainId,
      handoffDepth: 1,
      sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken,
      handoffFinal: true,
      agentSessionId: currentAgentSessionId(),
    }
    const intermediate = {
      ...payload,
      id: 'terminal-retry-intermediate',
      content: 'intermediate answer',
      handoffFinal: false,
    }

    const emitToRoomReaders = vi.spyOn(groupServer as any, 'emitToRoomReaders')
    expect(await emitAck<any>(agent, 'message', intermediate)).toEqual({ id: intermediate.id })
    const first = await emitAck<any>(agent, 'message', payload)
    const messageBroadcastsAfterFirst = emitToRoomReaders.mock.calls.filter(([, event]) => event === 'message').length
    const roomUpdatesAfterFirst = emitToRoomReaders.mock.calls.filter(([, event]) => event === 'room_updated').length
    const replay = await emitAck<any>(agent, 'message', payload)
    const mismatchedLease = await emitAck<any>(agent, 'message', {
      ...payload,
      sourceHandoffLeaseToken: `${payload.sourceHandoffLeaseToken}-forged`,
    })
    const mismatchedTimestamp = await emitAck<any>(agent, 'message', { ...payload, timestamp: payload.timestamp + 1 })
    const forgedIntermediateFinal = await emitAck<any>(agent, 'message', {
      ...intermediate,
      handoffFinal: true,
    })

    expect(first).toEqual({ id: payload.id })
    expect(replay).toEqual({ id: payload.id })
    expect(mismatchedLease).toEqual(expect.objectContaining({
      error: expect.stringMatching(/handoff|lease|terminal|replay|publication/i),
    }))
    expect(mismatchedTimestamp).toEqual(expect.objectContaining({
      error: expect.stringMatching(/handoff|terminal|replay|publication/i),
    }))
    expect(emitToRoomReaders.mock.calls.filter(([, event]) => event === 'message')).toHaveLength(messageBroadcastsAfterFirst)
    expect(emitToRoomReaders.mock.calls.filter(([, event]) => event === 'room_updated')).toHaveLength(roomUpdatesAfterFirst)
    expect(forgedIntermediateFinal).toEqual(expect.objectContaining({
      error: expect.stringMatching(/handoff|terminal|replay|publication/i),
    }))
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({ status: 'completed', leaseToken: '' })
  })

  it('rejects upgrading a persisted non-final message into a terminal replay after the job failed', async () => {
    const { human, agent } = await joinHumanAndAgent()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'failed-upgrade-trigger', content: '@Worker answer' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    const intermediate = {
      roomId: 'room-1',
      id: 'failed-upgrade-intermediate',
      content: 'partial answer',
      timestamp: 654321,
      role: 'assistant',
      handoffChainId: running.chainId,
      handoffDepth: running.depth + 1,
      sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken,
      handoffFinal: false,
      agentSessionId: currentAgentSessionId(),
    }

    expect(await emitAck<any>(agent, 'message', intermediate)).toEqual({ id: intermediate.id })
    expect(groupServer.getStorage().markHandoffJobFailed(
      running.id, running.leaseToken, 'terminal runtime failure', 0, 1,
    )).toBe(true)

    const forgedFinal = await emitAck<any>(agent, 'message', { ...intermediate, handoffFinal: true })

    expect(forgedFinal).toEqual(expect.objectContaining({
      error: expect.stringMatching(/handoff|terminal|replay|publication/i),
    }))
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({ status: 'failed', leaseToken: '' })
  })

  it('does not route an agent reply without a live durable source job', async () => {
    const { agent } = await joinHumanAndAgent()

    await emitAck(agent, 'message', {
      roomId: 'room-1', id: 'agent-msg-1', content: '@Worker chain handoff',
      role: 'assistant', mentionDepth: 1, agentSessionId: sessionId,
    })

    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([])
  })

  it('does not route agent replies at the default mention-depth guard', async () => {
    const { agent } = await joinHumanAndAgent()

  it('strips forged assistant and handoff metadata from human messages', async () => {
    const { human } = await joinHumanAndAgent()
    await emitAck(human, 'message', {
      roomId: 'room-1', id: 'human-forged', content: '@Worker hello', role: 'assistant',
      handoffChainId: 'forged-chain', handoffDepth: 99, sourceHandoffJobId: 'forged-job',
      sourceHandoffLeaseToken: 'forged-lease', handoffFinal: true, tool_name: 'workspace_diff',
    })

    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([])
  })
})
