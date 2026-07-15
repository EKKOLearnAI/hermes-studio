import { describe, expect, it } from 'vitest'
import {
  MAX_CHAT_INPUT_HEIGHT,
  MIN_CHAT_INPUT_HEIGHT,
  clampChatInputHeight,
  isMobileChatInputViewport,
} from '@/utils/chat-input-height'

describe('chat input height utils', () => {
  it('clamps configured heights into the supported range', () => {
    expect(clampChatInputHeight(undefined)).toBeNull()
    expect(clampChatInputHeight(null)).toBeNull()
    expect(clampChatInputHeight('')).toBeNull()
    expect(clampChatInputHeight(MIN_CHAT_INPUT_HEIGHT - 100)).toBe(MIN_CHAT_INPUT_HEIGHT)
    expect(clampChatInputHeight(MAX_CHAT_INPUT_HEIGHT + 100)).toBe(MAX_CHAT_INPUT_HEIGHT)
    expect(clampChatInputHeight(157.6)).toBe(158)
  })

  it('treats the existing mobile breakpoint as mobile-only behavior', () => {
    expect(isMobileChatInputViewport(768)).toBe(true)
    expect(isMobileChatInputViewport(769)).toBe(false)
  })
})