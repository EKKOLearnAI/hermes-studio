export function publicParticipantAvatar(value: unknown): Record<string, string> | null {
    if (!value) return null
    try {
        const avatar = typeof value === 'string' ? JSON.parse(value) : value
        return avatar && typeof avatar === 'object' && !Array.isArray(avatar)
            ? avatar as Record<string, string>
            : null
    } catch {
        return null
    }
}

export function serializeRoomAgent(agent: any) {
    if (!agent) return agent
    return {
        roomId: String(agent.roomId || ''),
        agentId: String(agent.agentId || ''),
        profile: String(agent.profile || ''),
        name: String(agent.name || ''),
        description: String(agent.description || ''),
        invited: Number(agent.invited || 0),
        runtime: agent.runtime === 'coding_agent' ? 'coding_agent' : 'hermes',
        codingAgentId: String(agent.codingAgentId || ''),
        mode: String(agent.mode || 'scoped'),
        provider: String(agent.provider || ''),
        model: String(agent.model || ''),
        apiMode: String(agent.apiMode || ''),
        reasoningEffort: String(agent.reasoningEffort || ''),
        avatar: publicParticipantAvatar(agent.avatar),
    }
}
