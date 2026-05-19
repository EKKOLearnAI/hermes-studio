export const ALL_AGENTS_MENTION = 'all'

type MentionableAgent = {
    name: string
    id?: string
    agentId?: string
}

type MentionRange = {
    start: number
    end: number
}

const BEFORE_BOUNDARY = new Set(['(', '[', '{', '<'])
const AFTER_BOUNDARY = new Set(['.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：', ')', ']', '}', '>'])

export function escapeMentionName(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isReservedMentionName(name: string): boolean {
    return name.trim().toLowerCase() === ALL_AGENTS_MENTION
}

function isBeforeBoundary(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char) || BEFORE_BOUNDARY.has(char)
}

function isAfterBoundary(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char) || AFTER_BOUNDARY.has(char)
}

function findMentionRanges(content: string, mentionName: string): MentionRange[] {
    if (!content || !mentionName) return []

    const contentLower = content.toLowerCase()
    const mentionLower = mentionName.toLowerCase()
    const ranges: MentionRange[] = []
    let fromIndex = 0

    while (fromIndex < content.length) {
        const atIndex = contentLower.indexOf(`@${mentionLower}`, fromIndex)
        if (atIndex === -1) break

        const start = atIndex
        const end = atIndex + mentionName.length + 1
        if (isBeforeBoundary(content[start - 1]) && isAfterBoundary(content[end])) {
            ranges.push({ start, end })
        }
        fromIndex = atIndex + 1
    }

    return ranges
}

export function isAgentMentioned(content: string, agentName: string): boolean {
    return findMentionRanges(content, agentName).length > 0
}

export function isAllAgentsMentioned(content: string): boolean {
    return isAgentMentioned(content, ALL_AGENTS_MENTION)
}

function isSenderAgent(agent: MentionableAgent, senderId: string): boolean {
    return Boolean(senderId && (agent.id === senderId || agent.agentId === senderId))
}

export function resolveMentionTargets<T extends MentionableAgent>(
    agents: T[],
    content: string,
    senderId: string,
): T[] {
    const candidates = agents.filter((agent) => !isSenderAgent(agent, senderId))

    if (isAllAgentsMentioned(content)) {
        return candidates
    }

    return candidates.filter((agent) => isAgentMentioned(content, agent.name))
}

export function stripMentionRoutingTokens(content: string, ownAgentName: string): string {
    const rangesByKey = new Map<string, MentionRange>()
    for (const range of [
        ...findMentionRanges(content, ALL_AGENTS_MENTION),
        ...findMentionRanges(content, ownAgentName),
    ]) {
        rangesByKey.set(`${range.start}:${range.end}`, range)
    }

    const ranges = [...rangesByKey.values()].sort((a, b) => b.start - a.start)

    let result = content
    for (const range of ranges) {
        result = `${result.slice(0, range.start)}${result.slice(range.end)}`
    }

    return result
        .replace(/^[\s,，:：;；.!?。！？]+/, '')
        .replace(/[\s,，:：;；]+$/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
}
