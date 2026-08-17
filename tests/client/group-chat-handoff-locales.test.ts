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
    expect(zh.groupChat.agentHandoffOutcomeUnknownTitle).toBe('远端接力结果未知')
    expect(zh.groupChat.agentHandoffOutcomeUnknownDescription).toBe('远端任务可能仍在执行。为避免重复执行，系统不会自动重试或再次开放继续操作，请先人工确认远端结果。')
    expect(Object.values(zh.groupChat).filter(value => typeof value === 'string' && /^(An Agent handoff|Depth:|Target Agent:|Continue this handoff|Adjust room settings)/.test(value))).toEqual([])
  })
})