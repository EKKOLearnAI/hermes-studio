import { describe, expect, it } from 'vitest'
import {
  generateGroupChatInviteCode,
  GROUP_CHAT_INVITE_CODE_LENGTH,
} from '../../packages/client/src/utils/group-chat-invite-code'

describe('group chat invite code generation', () => {
  it('generates a 16-character code without ambiguous characters', () => {
    const code = generateGroupChatInviteCode()

    expect(code).toHaveLength(GROUP_CHAT_INVITE_CODE_LENGTH)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/)
  })

  it('uses fresh random bytes for each code', () => {
    expect(generateGroupChatInviteCode()).not.toBe(generateGroupChatInviteCode())
  })
})
