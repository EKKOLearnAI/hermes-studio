export type MentionOption = {
    key: string
    type: 'all' | 'agent'
    name: string
    label: string
    description: string
}

type MentionAgent = {
    name: string
    profile?: string
    connectionStatus?: 'online' | 'offline'
}

function isReservedMentionName(name: string): boolean {
    return name.trim().toLowerCase() === 'all'
}

export function buildMentionOptions(
    agents: MentionAgent[],
    query: string,
    allowAll = true,
    allDescription = '',
): MentionOption[] {
    const normalizedQuery = query.trim().toLowerCase()
    const options: MentionOption[] = []

    if (allowAll && (!normalizedQuery || 'all'.includes(normalizedQuery))) {
        options.push({
            key: 'special:all',
            type: 'all',
            name: 'all',
            label: '@all',
            description: allDescription,
        })
    }

    for (const agent of agents) {
        if (agent.connectionStatus === 'offline') continue
        const agentName = agent.name || ''
        if (isReservedMentionName(agentName)) continue
        if (!agentName.toLowerCase().includes(normalizedQuery)) continue
        options.push({
            key: `agent:${agentName}`,
            type: 'agent',
            name: agentName,
            label: `@${agentName}`,
            description: agent.profile || '',
        })
    }

    return options
}
