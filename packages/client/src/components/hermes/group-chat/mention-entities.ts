export type DraftMention =
    | { type: 'participant'; participantId: string; displayName: string; start: number; length: number }
    | { type: 'all'; displayName: string; start: number; length: number }

export type MentionSelection =
    | { type: 'agent'; participantId: string; name: string }
    | { type: 'all'; name: string }

type ChainAgent = { agentId?: string; name: string }

export type StructuredChainRequest = {
    version: 1
    participants: Array<Extract<DraftMention, { type: 'participant' }>>
}

function participantAt(
    text: string,
    start: number,
    mentions: readonly DraftMention[],
    agents: readonly ChainAgent[],
): Extract<DraftMention, { type: 'participant' }> | null {
    const entity = mentions.find((mention): mention is Extract<DraftMention, { type: 'participant' }> =>
        mention.type === 'participant' && mention.start === start && text.slice(start, start + mention.length) === renderedMention(mention),
    )
    if (entity) return { ...entity }
    const candidates = agents
        .map(agent => ({ participantId: String(agent.agentId || '').trim(), displayName: String(agent.name || '') }))
        .filter(agent => agent.participantId && agent.displayName && agent.displayName.toLowerCase() !== 'all')
        .sort((left, right) => right.displayName.length - left.displayName.length)
    for (const candidate of candidates) {
        const rendered = `@${candidate.displayName}`
        if (text.slice(start, start + rendered.length) !== rendered) continue
        const next = text[start + rendered.length]
        if (next && !/\s|→|-/u.test(next)) continue
        return {
            type: 'participant',
            participantId: candidate.participantId,
            displayName: candidate.displayName,
            start,
            length: rendered.length,
        }
    }
    return null
}

export function structuredChainForSubmission(
    text: string,
    mentions: readonly DraftMention[],
    agents: readonly ChainAgent[],
): StructuredChainRequest | undefined {
    const leadingArrowIntent = /^@\S+\s*(?:→|->)\s*@/u.test(text)
    let cursor = 0
    const participants: Array<Extract<DraftMention, { type: 'participant' }>> = []
    const first = participantAt(text, cursor, mentions, agents)
    if (!first) {
        if (leadingArrowIntent) throw new Error('Invalid participant chain. Choose Room participants from the mention picker.')
        return undefined
    }
    participants.push(first)
    cursor += first.length
    let firstArrowFound = false

    while (true) {
        while (/\s/u.test(text[cursor] || '')) cursor += 1
        const arrowLength = text.startsWith('→', cursor) ? 1 : text.startsWith('->', cursor) ? 2 : 0
        if (!arrowLength) break
        firstArrowFound = true
        cursor += arrowLength
        while (/\s/u.test(text[cursor] || '')) cursor += 1
        const participant = participantAt(text, cursor, mentions, agents)
        if (!participant) throw new Error('Invalid participant chain. Choose every Room participant from the mention picker.')
        participants.push(participant)
        cursor += participant.length
    }

    if (participants.length < 2) {
        if (firstArrowFound) throw new Error('Invalid participant chain. At least two Room participants are required.')
        return undefined
    }
    return { version: 1, participants }
}

export function mentionsForSubmission(mentions: readonly DraftMention[]): DraftMention[] | undefined {
    if (mentions.length === 0) return undefined
    const seenParticipants = new Set<string>()
    return mentions.filter((mention) => {
        if (mention.type !== 'participant') return true
        if (seenParticipants.has(mention.participantId)) return false
        seenParticipants.add(mention.participantId)
        return true
    })
}

function renderedMention(mention: DraftMention): string {
    return `@${mention.displayName}`
}

function commonPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length)
    let index = 0
    while (index < limit && left[index] === right[index]) index += 1
    return index
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
    const limit = Math.min(left.length, right.length) - prefixLength
    let length = 0
    while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1
    return length
}

export function reconcileMentionEdit(
    previousText: string,
    previousMentions: readonly DraftMention[],
    nextText: string,
): DraftMention[] {
    if (previousMentions.length === 0 || previousText === nextText) return [...previousMentions]
    const prefix = commonPrefixLength(previousText, nextText)
    const suffix = commonSuffixLength(previousText, nextText, prefix)
    const oldChangeEnd = previousText.length - suffix
    const delta = nextText.length - previousText.length

    return previousMentions.flatMap((mention) => {
        const mentionEnd = mention.start + mention.length
        let nextStart: number
        if (mentionEnd <= prefix) {
            nextStart = mention.start
        } else if (mention.start >= oldChangeEnd) {
            nextStart = mention.start + delta
        } else {
            return []
        }
        const mapped = { ...mention, start: nextStart }
        return nextText.slice(nextStart, nextStart + mention.length) === renderedMention(mapped) ? [mapped] : []
    })
}

export function applyMentionSelection(
    text: string,
    mentions: readonly DraftMention[],
    replaceStart: number,
    replaceEnd: number,
    option: MentionSelection,
): { text: string; cursor: number; mentions: DraftMention[] } {
    const displayName = option.name
    const inserted = `@${displayName}`
    const remainder = text.slice(replaceEnd)
    const separator = /^\s/u.test(remainder) ? '' : ' '
    const nextText = `${text.slice(0, replaceStart)}${inserted}${separator}${remainder}`
    const retained = reconcileMentionEdit(text, mentions, nextText)
        .filter(mention => option.type === 'all' ? false : mention.type !== 'all')
    const selected: DraftMention = option.type === 'all'
        ? { type: 'all', displayName, start: replaceStart, length: inserted.length }
        : { type: 'participant', participantId: option.participantId, displayName, start: replaceStart, length: inserted.length }
    return {
        text: nextText,
        cursor: replaceStart + inserted.length + 1,
        mentions: [...retained, selected].sort((left, right) => left.start - right.start),
    }
}
