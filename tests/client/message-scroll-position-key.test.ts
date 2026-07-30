import { describe, expect, it } from 'vitest'
import {
  messageScrollPositionKey,
  rememberMessageScrollPosition,
  type MessageViewportScrollSnapshot,
} from '@/components/hermes/chat/message-scroll-position'

const snapshot: MessageViewportScrollSnapshot = {
  anchorMessageId: 'message-1',
  anchorOffset: 0,
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
  wasNearBottom: false,
}

describe('messageScrollPositionKey', () => {
  it('separates scroll positions by surface, profile, and session', () => {
    const chatKey = messageScrollPositionKey('chat', { id: 'session-1', profile: 'profile-a' })

    expect(chatKey).not.toBe(messageScrollPositionKey('history', { id: 'session-1', profile: 'profile-a' }))
    expect(chatKey).not.toBe(messageScrollPositionKey('chat', { id: 'session-1', profile: 'profile-b' }))
    expect(chatKey).not.toBe(messageScrollPositionKey('chat', { id: 'session-2', profile: 'profile-a' }))
  })

  it('evicts the oldest snapshots when the in-memory cache reaches its limit', () => {
    const positions = new Map<string, MessageViewportScrollSnapshot>()

    rememberMessageScrollPosition(positions, 'session-a', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-b', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-c', snapshot, 2)

    expect([...positions.keys()]).toEqual(['session-b', 'session-c'])
  })
})
