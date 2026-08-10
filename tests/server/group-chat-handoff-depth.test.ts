import { describe, expect, it } from 'vitest'
import {
    DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH,
    isStrictBoolean,
    isValidHandoffDepth,
    recommendedGroupChatAgentHandoffDepth,
    resolveGroupChatAgentHandoffPolicy,
    shouldRouteGroupChatAgentHandoff,
} from '../../packages/server/src/services/hermes/group-chat/handoff-depth'

describe('group chat room Agent handoff depth policy', () => {
    it('recommends at least four hops plus the active participant count', () => {
        expect(recommendedGroupChatAgentHandoffDepth(0)).toBe(4)
        expect(recommendedGroupChatAgentHandoffDepth(3)).toBe(4)
        expect(recommendedGroupChatAgentHandoffDepth(5)).toBe(6)
    })

    it('resolves explicit room values before the server default and then the legacy default', () => {
        expect(resolveGroupChatAgentHandoffPolicy({ maxDepth: 6 }, 4)).toEqual({ enabled: true, maxDepth: 6, unlimited: false })
        expect(resolveGroupChatAgentHandoffPolicy({}, 7)).toEqual({ enabled: true, maxDepth: 7, unlimited: false })
        expect(resolveGroupChatAgentHandoffPolicy({}, undefined)).toEqual({
            enabled: true,
            maxDepth: DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH,
            unlimited: false,
        })
        expect(resolveGroupChatAgentHandoffPolicy({ unlimited: true }, 4)).toEqual({ enabled: true, maxDepth: null, unlimited: true })
    })

    it('stops at the effective maximum but allows the preceding depth', () => {
        expect(shouldRouteGroupChatAgentHandoff(3, { enabled: true, maxDepth: 4, unlimited: false })).toBe(true)
        expect(shouldRouteGroupChatAgentHandoff(4, { enabled: true, maxDepth: 4, unlimited: false })).toBe(false)
        expect(shouldRouteGroupChatAgentHandoff(4, { enabled: true, maxDepth: null, unlimited: true })).toBe(true)
        expect(shouldRouteGroupChatAgentHandoff(0, { enabled: false, maxDepth: 4, unlimited: false })).toBe(false)
    })

    it('rejects coercible API values instead of treating strings as truthy', () => {
        expect(isStrictBoolean(true)).toBe(true)
        expect(isStrictBoolean(false)).toBe(true)
        expect(isStrictBoolean('false')).toBe(false)
        expect(isValidHandoffDepth(1)).toBe(true)
        expect(isValidHandoffDepth(null)).toBe(true)
        expect(isValidHandoffDepth('4')).toBe(false)
        expect(isValidHandoffDepth(101)).toBe(false)
    })
})
