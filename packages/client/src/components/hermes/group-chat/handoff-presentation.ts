import type { RoomAgentHandoffChain } from '@/api/hermes/group-chat'

export function isPresentableHandoffChain(chain: RoomAgentHandoffChain): boolean {
    const currentDepth = Number(chain.currentDepth)
    const maxDepth = Number(chain.maxDepth)
    const hasPresentableReason = chain.stopReason === 'max_depth'
        || (chain.stopReason === 'continue_failed'
            && Boolean(chain.attemptId)
            && typeof chain.lastError === 'string'
            && chain.lastError.trim().length > 0)
    return chain.status === 'stopped'
        && hasPresentableReason
        && !Boolean(chain.unlimited)
        && Boolean(chain.sourceMessageId)
        && Boolean(chain.targetAgentId)
        && Number.isSafeInteger(currentDepth)
        && Number.isSafeInteger(maxDepth)
        && currentDepth < Number.MAX_SAFE_INTEGER
        && maxDepth >= 1
        && currentDepth >= maxDepth
}
