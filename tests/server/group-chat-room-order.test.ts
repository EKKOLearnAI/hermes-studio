import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestGroupChatServer } from './group-chat-test-helpers'

describe('group chat room ordering', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>

  beforeEach(async () => {
    harness = await createTestGroupChatServer()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('returns rooms by last persisted visible activity with empty rooms using creation time', () => {
    const storage = harness.groupServer.getStorage()
    storage.saveRoom('older-empty', 'Older empty', 'OLD')
    harness.db.prepare('UPDATE gc_rooms SET createdAt = ? WHERE id = ?').run(100, 'older-empty')
    storage.saveRoom('active', 'Active', 'ACTIVE')
    harness.db.prepare('UPDATE gc_rooms SET createdAt = ? WHERE id = ?').run(200, 'active')
    storage.saveRoom('new-empty', 'New empty', 'NEW')
    harness.db.prepare('UPDATE gc_rooms SET createdAt = ? WHERE id = ?').run(400, 'new-empty')
    storage.saveMessageAndRefreshRoom({
      id: 'message-1',
      roomId: 'active',
      senderId: 'human-1',
      senderName: 'Alice',
      content: 'persisted',
      timestamp: 500,
      role: 'user',
    } as any)

    expect(storage.getAllRooms().map(room => [room.id, room.createdAt, room.lastActiveAt])).toEqual([
      ['active', 200, 500],
      ['new-empty', 400, 400],
      ['older-empty', 100, 100],
    ])
  })
})
