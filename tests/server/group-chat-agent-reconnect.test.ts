import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { io, type Socket } from 'socket.io-client'
import { createTestGroupChatServer, once } from './group-chat-test-helpers'
import { AgentClient } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'

describe('group Agent connection recovery', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let agent: AgentClient
  let secondAgent: AgentClient | undefined
  let socket: Socket

  beforeEach(async () => {
    harness = await createTestGroupChatServer()
    const storage = harness.groupServer.getStorage()
    storage.saveRoom('room-1', 'Room', 'INVITE1')
    storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    agent = new AgentClient({
      agentId: 'agent-1', profile: 'default', name: 'Worker', description: '',
      invited: 0, backgroundDelegationEnabled: false,
    })
    await agent.connect(harness.port)
    await harness.groupServer.agentClients.addAgentToRoom('room-1', agent)
    socket = (agent as any).socket
  })

  afterEach(async () => {
    await agent?.disconnect()
    await secondAgent?.disconnect()
    secondAgent = undefined
    harness?.cleanup()
  })

  it('keeps the local Agent online when a relay namespace closes its transport', async () => {
    harness.groupServer.getStorage().addRoomAgent('room-1', 'agent-2', 'default', 'Second', '', 0)
    secondAgent = new AgentClient({
      agentId: 'agent-2', profile: 'default', name: 'Second', description: '',
      invited: 0, backgroundDelegationEnabled: false,
    })
    await secondAgent.connect(harness.port)
    await harness.groupServer.agentClients.addAgentToRoom('room-1', secondAgent)
    const namespace = harness.groupServer.getIO().of('/group-chat-agent-relay')
    const relay = io(`http://127.0.0.1:${harness.port}/group-chat-agent-relay`, {
      transports: ['websocket'], reconnection: false,
    })
    harness.sockets.push(relay)
    await once(relay, 'connect')
    const closed = once(relay, 'disconnect')
    namespace.sockets.get(relay.id!)!.disconnect(true)
    await closed

    expect(secondAgent.connected).toBe(true)
    expect(agent.connected).toBe(true)
    expect(harness.groupServer.agentClients.getConnectedAgents('room-1')).toContain(agent)
    expect(harness.groupServer.getIO().of('/group-chat').sockets.get(socket.id!)?.rooms.has('room-1')).toBe(true)
  })

  it('rejoins after each transport reconnect once the group namespace is connected', async () => {
    socket.io.reconnectionDelay(10)
    socket.io.reconnectionDelayMax(20)
    const namespace = harness.groupServer.getIO().of('/group-chat')
    for (let attempt = 0; attempt < 2; attempt++) {
      const oldId = socket.id!
      const connected = once(socket, 'connect')
      namespace.sockets.get(oldId)!.conn.close()
      await connected
      expect(socket.id).not.toBe(oldId)
      await vi.waitFor(() => {
        expect(namespace.sockets.get(socket.id!)?.rooms.has('room-1')).toBe(true)
      })
    }
  })
})
