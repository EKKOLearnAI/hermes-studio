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

    expect(storage.getAllRooms().map(room => room.id)).toEqual(['active', 'new-empty', 'older-empty'])
  })

  it('orders by server persistence time rather than an agent-supplied future display timestamp', () => {
    const storage = harness.groupServer.getStorage()
    storage.saveRoom('future-agent', 'Future agent', 'FUTURE')
    storage.saveRoom('recent-human', 'Recent human', 'RECENT')
    harness.db.prepare('UPDATE gc_rooms SET createdAt = ? WHERE id = ?').run(100, 'future-agent')
    harness.db.prepare('UPDATE gc_rooms SET createdAt = ? WHERE id = ?').run(200, 'recent-human')
    harness.db.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, persistedAt, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('agent-future', 'future-agent', 'agent-1', 'Agent', 'future', 9_999_999_999_999, 300, 'assistant')
    harness.db.prepare(
      'INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, persistedAt, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('human-recent', 'recent-human', 'human-1', 'Human', 'recent', 400, 400, 'user')

    expect(storage.getAllRooms().map(room => room.id)).toEqual(['recent-human', 'future-agent'])
  })
})
