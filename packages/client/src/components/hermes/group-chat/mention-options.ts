export type MentionOption = {
    key: string
    type: 'all' | 'agent'
    name: string
    participantId?: string
    label: string
    description: string
}

type MentionAgent = {
    name: string
    id?: string
    agentId?: string
    profile?: string
}

function isReservedMentionName(name: string): boolean {
    return name.trim().toLowerCase() === 'all'
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
        options.push({
            key: `agent:${agent.agentId || agent.id || agentName}`,
            type: 'agent',
            name: agentName,
            participantId: agent.agentId || agent.id,
            label: `@${agentName}`,
            description: agent.profile || '',
        })
    }

    return options
}
