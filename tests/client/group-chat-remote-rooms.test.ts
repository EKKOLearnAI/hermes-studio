import { describe, expect, it } from 'vitest'
import type { LocalGroupAgentConnection } from '../../packages/client/src/api/studio/group-chat-agent-link'
import { buildRemoteGroupChatRooms } from '../../packages/client/src/utils/group-chat-remote-rooms'

function connection(input: Partial<LocalGroupAgentConnection>): LocalGroupAgentConnection {
  return {
    connectorId: input.connectorId || 'connector-1',
    cloudOrigin: input.cloudOrigin || 'https://remote.example',
    targetOrigin: input.targetOrigin || 'http://127.0.0.1:8648',
    roomId: input.roomId,
    roomName: input.roomName,
    roomAlias: input.roomAlias,
    inviteCode: input.inviteCode,
    connected: input.connected ?? false,
    agent: input.agent || {
      agent: 'hermes',
      profile: 'default',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
      name: 'Agent',
      description: '',
      avatar: '',
    },
  }
}

describe('remote group chat room list', () => {
  it('deduplicates multiple Agent connectors by cloud origin and room id', () => {
    const rooms = buildRemoteGroupChatRooms([
      connection({ connectorId: 'one', roomId: 'room-1', roomName: 'Room One', connected: false }),
      connection({ connectorId: 'two', roomId: 'room-1', inviteCode: 'ROOM1', connected: true }),
    ])

    expect(rooms).toEqual([
      expect.objectContaining({
        roomId: 'room-1',
        roomName: 'Room One',
        inviteCode: 'ROOM1',
        cloudOrigin: 'https://remote.example',
        connected: true,
        connectorIds: ['one', 'two'],
      }),
    ])
  })

  it('prefers a local room alias over the cloud room name', () => {
    const rooms = buildRemoteGroupChatRooms([
      connection({ roomId: 'room-1', roomName: 'Cloud Name', roomAlias: 'My Name' }),
    ])

    expect(rooms[0]).toMatchObject({ roomName: 'My Name', roomAlias: 'My Name' })
  })

  it('keeps identical room ids from different origins as separate remote rooms', () => {
    const rooms = buildRemoteGroupChatRooms([
      connection({ connectorId: 'local-copy', cloudOrigin: 'http://localhost:8648/', roomId: 'shared-id' }),
      connection({ connectorId: 'remote-copy', cloudOrigin: 'https://remote.example/', roomId: 'shared-id' }),
    ])

    expect(rooms).toHaveLength(2)
    expect(rooms.map(room => room.cloudOrigin)).toEqual([
      'http://localhost:8648',
      'https://remote.example',
    ])
  })

  it('omits legacy links until a successful Relay connection supplies a room id', () => {
    expect(buildRemoteGroupChatRooms([
      connection({ roomId: undefined }),
    ])).toEqual([])
  })
})
