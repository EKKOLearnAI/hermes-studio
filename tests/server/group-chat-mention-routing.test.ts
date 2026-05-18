import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('Group chat mention routing', () => {
  function createFakeAgent(name: string, agentId = `agent-${name.toLowerCase()}`, socketId = `socket-${name.toLowerCase()}`) {
    return {
      agentId,
      id: socketId,
      name,
      joinRoom: vi.fn().mockResolvedValue({
        roomId: 'room-1',
        roomName: 'room-1',
        members: [],
        messages: [],
        rooms: [],
      }),
      replyToMention: vi.fn().mockResolvedValue(undefined),
      emitContextStatus: vi.fn(),
      disconnect: vi.fn(),
    }
  }

  async function setupRoom() {
    const clients = new AgentClients()
    ;(clients as any)._gatewayManager = {}

    const manager = createFakeAgent('manager')
    const koolie = createFakeAgent('koolie')
    const bob = createFakeAgent('Bob')
    const regexName = createFakeAgent('C++')
    await clients.addAgentToRoom('room-1', manager as any)
    await clients.addAgentToRoom('room-1', koolie as any)
    await clients.addAgentToRoom('room-1', bob as any)
    await clients.addAgentToRoom('room-1', regexName as any)

    return { clients, manager, koolie, bob, regexName }
  }

  it('does not wake another agent when an agent only mentions it in quoted prose', async () => {
    const { clients, manager, koolie } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '我只是举例“@koolie”这个写法，不是在叫你。',
      senderName: 'manager',
      senderId: manager.agentId,
      senderIsAgent: true,
      timestamp: Date.now(),
    } as any)

    expect(koolie.replyToMention).not.toHaveBeenCalled()
  })

  it('routes an explicit leading handoff from one agent to another agent', async () => {
    const { clients, manager, koolie } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '@koolie，做个单轮测试。',
      senderName: 'manager',
      senderId: manager.agentId,
      senderIsAgent: true,
      timestamp: Date.now(),
    } as any)

    expect(koolie.replyToMention).toHaveBeenCalledTimes(1)
    expect(manager.replyToMention).not.toHaveBeenCalled()
  })

  it('does not route an agent self-mention back to itself', async () => {
    const { clients, manager } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '@manager 我不应该再次唤醒自己。',
      senderName: 'manager',
      senderId: manager.agentId,
      senderIsAgent: true,
      timestamp: Date.now(),
    } as any)

    expect(manager.replyToMention).not.toHaveBeenCalled()
  })

  it('still routes normal human mentions anywhere in the message', async () => {
    const { clients, koolie } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '我觉得可以请@koolie，看一下。',
      senderName: 'manager',
      senderId: 'human-user-with-agent-display-name',
      timestamp: Date.now(),
    })

    expect(koolie.replyToMention).toHaveBeenCalledTimes(1)
  })

  it('does not classify a spoofed stable agent id as agent-authored without the server-owned flag', async () => {
    const { clients, manager } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '@manager 如果这是普通用户消息，应该仍然能叫到 manager。',
      senderName: 'spoofed-user',
      senderId: manager.agentId,
      timestamp: Date.now(),
    })

    expect(manager.replyToMention).toHaveBeenCalledTimes(1)
  })

  it('does not treat a longer handle as a mention of a shorter agent name', async () => {
    const { clients, bob } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '请 @Bobcat 看一下。',
      senderName: 'Han',
      senderId: 'user-han',
      timestamp: Date.now(),
    })

    expect(bob.replyToMention).not.toHaveBeenCalled()
  })

  it('escapes regex metacharacters in agent names', async () => {
    const { clients, regexName } = await setupRoom()

    await clients.processMentions('room-1', {
      content: '麻烦 @C++: 看一下。',
      senderName: 'Han',
      senderId: 'user-han',
      timestamp: Date.now(),
    })

    expect(regexName.replyToMention).toHaveBeenCalledTimes(1)
  })
})
