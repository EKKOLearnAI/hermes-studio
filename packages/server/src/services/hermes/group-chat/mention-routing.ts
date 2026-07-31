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
const QUOTED_MESSAGE_BLOCK_RE = /<quoted_message(?:\s[^>]*)?>[\s\S]*?<\/quoted_message>/gi

function maskQuotedMessageBlocks(content: string): string {
    return content.replace(QUOTED_MESSAGE_BLOCK_RE, block => block.replace(/[^\n]/g, ' '))
}

export function escapeMentionName(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isReservedMentionName(name: string): boolean {
    return name.trim().toLowerCase() === ALL_AGENTS_MENTION
}

function isMentionBoundary(char: string | undefined): boolean {
    return char === undefined
        || /\s/u.test(char)
        || BEFORE_BOUNDARY.has(char)
        || AFTER_BOUNDARY.has(char)
        || /[\p{P}\p{S}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
}

function isBeforeBoundary(char: string | undefined): boolean {
    return isMentionBoundary(char)
}

function isAfterBoundary(char: string | undefined): boolean {
    return isMentionBoundary(char)
}

function findMentionRanges(content: string, mentionName: string): MentionRange[] {
    if (!content || !mentionName) return []

    const routableContent = maskQuotedMessageBlocks(content)
    const contentLower = routableContent.toLowerCase()
    const mentionLower = mentionName.toLowerCase()
    const ranges: MentionRange[] = []
    let fromIndex = 0

    while (fromIndex < content.length) {
        const atIndex = contentLower.indexOf(`@${mentionLower}`, fromIndex)
        if (atIndex === -1) break

        const start = atIndex
        const end = atIndex + mentionName.length + 1
        if (isBeforeBoundary(routableContent[start - 1]) && isAfterBoundary(routableContent[end])) {
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

export type MentionResolution<T extends MentionableAgent> = {
    targets: T[]
    isBroadcast: boolean
}

export function resolveMentionRoute<T extends MentionableAgent>(
    agents: T[],
    content: string,
    senderId: string,
): MentionResolution<T> {
    const rangesByAgent = agents.map(agent => ({
        agent,
        ranges: findMentionRanges(content, agent.name),
    }))
    const allRanges = findMentionRanges(content, ALL_AGENTS_MENTION)
    const longestEndByStart = new Map<number, number>()
    for (const ranges of [allRanges, ...rangesByAgent.map(({ ranges }) => ranges)]) {
        for (const range of ranges) {
            longestEndByStart.set(range.start, Math.max(longestEndByStart.get(range.start) || 0, range.end))
        }
    }

    const isBroadcast = allRanges.some(range => longestEndByStart.get(range.start) === range.end)
    if (isBroadcast) {
        return {
            targets: agents.filter(agent => !isSenderAgent(agent, senderId)),
            isBroadcast: true,
        }
    }

    return {
        targets: rangesByAgent
            .filter(({ agent, ranges }) => !isSenderAgent(agent, senderId)
                && ranges.some(range => longestEndByStart.get(range.start) === range.end))
            .map(({ agent }) => agent),
        isBroadcast: false,
    }
}

export function resolveMentionTargets<T extends MentionableAgent>(
    agents: T[],
    content: string,
    senderId: string,
): T[] {
    return resolveMentionRoute(agents, content, senderId).targets
}

export function stripMentionRoutingTokens(
    content: string,
    ownAgentName: string,
    roomAgentNames: string[] = [ownAgentName],
): string {
    const allRanges = findMentionRanges(content, ALL_AGENTS_MENTION)
    const ownRanges = findMentionRanges(content, ownAgentName)
    const longestEndByStart = new Map<number, number>()
    for (const mentionName of [ALL_AGENTS_MENTION, ...roomAgentNames]) {
        for (const range of findMentionRanges(content, mentionName)) {
            longestEndByStart.set(range.start, Math.max(longestEndByStart.get(range.start) || 0, range.end))
        }
    }

    const ranges = [...allRanges, ...ownRanges]
        .filter(range => longestEndByStart.get(range.start) === range.end)
        .filter((range, index, all) => all.findIndex(candidate => candidate.start === range.start && candidate.end === range.end) === index)
        .sort((a, b) => b.start - a.start)

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
