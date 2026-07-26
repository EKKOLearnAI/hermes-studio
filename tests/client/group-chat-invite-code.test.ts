import { describe, expect, it } from 'vitest'

import {
  generateGroupChatInviteCode,
  groupChatInviteCodeForClone,
  groupChatInviteCodeForCreate,
  GROUP_CHAT_INVITE_CODE_LENGTH,
} from '../../packages/client/src/utils/group-chat-invite'

describe('group chat invite code generation', () => {
  it('uses a 32-character alphabet for at least 80 bits of generated entropy', () => {
    const codes = Array.from({ length: 64 }, () => generateGroupChatInviteCode())

    expect(GROUP_CHAT_INVITE_CODE_LENGTH).toBe(16)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
    }
  })

  it('preserves explicit invite bytes and only treats the exact empty string as absent', () => {
    expect(groupChatInviteCodeForCreate(' ROOM1 ')).toBe(' ROOM1 ')
    expect(groupChatInviteCodeForClone(' Room1 ')).toBe(' Room1 ')
    expect(groupChatInviteCodeForClone('')).toBeUndefined()
    expect(groupChatInviteCodeForCreate('')).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
  })
})
