export type DraftMention =
    | { type: 'participant'; participantId: string; displayName: string; start: number; length: number }
    | { type: 'all'; displayName: string; start: number; length: number }

export type MentionSelection =
    | { type: 'agent'; participantId: string; name: string }
    | { type: 'all'; name: string }

export function mentionsForSubmission(mentions: readonly DraftMention[]): DraftMention[] | undefined {
    return mentions.length > 0 ? [...mentions] : undefined
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
    const withoutDuplicateTarget = selected.type === 'participant'
        ? retained.filter(mention => mention.type !== 'participant' || mention.participantId !== selected.participantId)
        : []
    return {
        text: nextText,
        cursor: replaceStart + inserted.length + 1,
        mentions: [...withoutDuplicateTarget, selected].sort((left, right) => left.start - right.start),
    }
}
