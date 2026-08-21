// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  GROUP_CHAT_ROOM_DRAFT_MAX_AGE_MS,
  GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY,
  clearGroupChatRoomDraft,
  loadGroupChatRoomDraft,
  saveGroupChatRoomDraft,
} from '@/components/hermes/group-chat/group-chat-room-drafts'

describe('group chat room drafts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('isolates text and structured mention positions by room', () => {
    saveGroupChatRoomDraft('room-a', {
      text: '@Worker inspect this',
      mentions: [{
        type: 'agent',
        participantId: 'agent-1',
        displayName: 'Worker',
        start: 0,
        end: 7,
      }],
    })
    saveGroupChatRoomDraft('room-b', {
      text: '@all status',
      mentions: [{
        type: 'all',
        displayName: 'all',
        start: 0,
        end: 4,
      }],
    })

    expect(loadGroupChatRoomDraft('room-a')).toEqual({
      text: '@Worker inspect this',
      mentions: [{
        type: 'agent',
        participantId: 'agent-1',
        displayName: 'Worker',
        start: 0,
        end: 7,
      }],
    })
    expect(loadGroupChatRoomDraft('room-b')).toEqual({
      text: '@all status',
      mentions: [{
        type: 'all',
        displayName: 'all',
        start: 0,
        end: 4,
      }],
    })

    clearGroupChatRoomDraft('room-a')
    expect(loadGroupChatRoomDraft('room-a')).toBeNull()
    expect(loadGroupChatRoomDraft('room-b')?.text).toBe('@all status')
  })

  it('drops corrupt and expired data without throwing', () => {
    localStorage.setItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY, '{broken')
    expect(loadGroupChatRoomDraft('room-a')).toBeNull()
    expect(localStorage.getItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY)).toBeNull()

    localStorage.setItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY, JSON.stringify({
      version: 1,
      rooms: {
        'room-a': {
          text: 'stale',
          mentions: [],
          updatedAt: Date.now() - GROUP_CHAT_ROOM_DRAFT_MAX_AGE_MS - 1,
          attachments: [{ name: 'must-not-restore.txt' }],
          reply: { id: 'message-1' },
        },
      },
    }))

    expect(loadGroupChatRoomDraft('room-a')).toBeNull()
    expect(localStorage.getItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('ignores invalid mention metadata while preserving safe text', () => {
    localStorage.setItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY, JSON.stringify({
      version: 1,
      rooms: {
        'room-a': {
          text: '@Worker inspect',
          mentions: [
            { type: 'agent', participantId: '', displayName: 'Worker', start: 0, end: 7 },
            { type: 'agent', participantId: 'agent-1', displayName: 'Wrong', start: 0, end: 6 },
          ],
          updatedAt: Date.now(),
        },
      },
    }))

    expect(loadGroupChatRoomDraft('room-a')).toEqual({
      text: '@Worker inspect',
      mentions: [],
    })
  })
})
