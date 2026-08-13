import { describe, expect, it } from 'vitest'
import zh from '../../packages/client/src/i18n/locales/zh'

describe('group chat handoff Chinese copy', () => {
  it('does not expose English stop-card copy in the Chinese locale', () => {
    expect(zh.groupChat.agentHandoffStopped).toBe('Agent 接力已达到最大深度。')
    expect(zh.groupChat.agentHandoffDepthState).toBe('接力深度：{current} / {max}')
    expect(zh.groupChat.agentHandoffTarget).toBe('目标 Agent：{target}')
    expect(zh.groupChat.agentHandoffContinue).toBe('继续本次接力')
    expect(zh.groupChat.agentHandoffAdjustSettings).toBe('调整房间设置')
    expect(zh.groupChat.agentHandoffErrorAdmissionRejected).toBe('目标 Agent 未能接收本次接力，请重试。')
    expect(Object.values(zh.groupChat).filter(value => typeof value === 'string' && /^(An Agent handoff|Depth:|Target Agent:|Continue this handoff|Adjust room settings)/.test(value))).toEqual([])
  })
})