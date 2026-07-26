export type MentionOption = {
    key: string
    type: 'all' | 'agent'
    name: string
    label: string
    description: string
    participantId?: string
}

type MentionAgent = {
    id?: string
    agentId?: string
    name: string
    profile?: string
    runtime?: 'hermes' | 'coding_agent'
    codingAgentId?: '' | 'claude-code' | 'codex'
}

function isReservedMentionName(name: string): boolean {
    return name.trim().toLowerCase() === 'all'
}

function participantRuntimeLabel(agent: MentionAgent): string {
    if (agent.runtime !== 'coding_agent') return 'Hermes'
    return agent.codingAgentId === 'claude-code' ? 'Claude Code' : 'Codex'
}

export function buildMentionOptions(agents: MentionAgent[], query: string): MentionOption[] {
    const normalizedQuery = query.trim().toLowerCase()
    const options: MentionOption[] = []

    if (!normalizedQuery || 'all'.includes(normalizedQuery)) {
        options.push({
            key: 'special:all',
            type: 'all',
            name: 'all',
            label: '@all',
            description: 'All agents',
        })
    }

    for (const agent of agents) {
        const agentName = agent.name || ''
        if (isReservedMentionName(agentName)) continue
        if (!agentName.toLowerCase().includes(normalizedQuery)) continue
        const participantId = String(agent.agentId || agent.id || agentName)
        options.push({
            key: `agent:${participantId}`,
            type: 'agent',
            participantId,
            name: agentName,
            label: `@${agentName}`,
            description: [participantRuntimeLabel(agent), agent.profile || ''].filter(Boolean).join(' · '),
        })
    }

    return options
}
