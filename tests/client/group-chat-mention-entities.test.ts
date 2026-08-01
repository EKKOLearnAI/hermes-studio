import { describe, expect, it } from 'vitest'
import {
  applyMentionSelection,
  mentionsForSubmission,
  reconcileMentionEdit,
  structuredChainForSubmission,
  type DraftMention,
} from '@/components/hermes/group-chat/mention-entities'

const worker: DraftMention = {
  type: 'participant', participantId: 'participant-worker', displayName: 'Worker', start: 0, length: 7,
}

describe('group chat structured mention entities', () => {
  it('binds a selected participant identity to the inserted display range', () => {
    expect(applyMentionSelection('@wo continue', [], 0, 3, {
      type: 'agent', participantId: 'participant-worker', name: 'Worker',
    })).toEqual({
      text: '@Worker continue',
      cursor: 8,
      mentions: [worker],
    })
  })

  it('binds @all as an explicit structured target', () => {
    expect(applyMentionSelection('@a', [], 0, 2, { type: 'all', name: 'all' })).toEqual({
      text: '@all ', cursor: 5,
      mentions: [{ type: 'all', displayName: 'all', start: 0, length: 4 }],
    })
  })

  it('shifts a selected mention after an edit before it', () => {
    expect(reconcileMentionEdit('@Worker continue', [worker], 'Hi @Worker continue')).toEqual([
      { ...worker, start: 3 },
    ])
  })

  it('invalidates an entity when its rendered mention text is edited or deleted', () => {
    expect(reconcileMentionEdit('@Worker continue', [worker], '@Work continue')).toEqual([])
    expect(reconcileMentionEdit('@Worker continue', [worker], 'continue')).toEqual([])
  })

  it('does not invent entities for mention-shaped text typed or pasted by hand', () => {
    expect(reconcileMentionEdit('', [], '@Worker continue')).toEqual([])
  })

  it('omits structured metadata when a submission has no picker-backed entities', () => {
    expect(mentionsForSubmission([])).toBeUndefined()
  })

  it('builds stable participant ids from a typed or pasted leading arrow chain', () => {
    const text = '@Hermes → @Codex → @Claude Code compare this implementation'
    expect(structuredChainForSubmission(text, [], [
      { agentId: 'hermes', name: 'Hermes' },
      { agentId: 'codex', name: 'Codex' },
      { agentId: 'claude', name: 'Claude Code' },
    ])).toEqual({
      version: 1,
      participants: [
        { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 0, length: 7 },
        { type: 'participant', participantId: 'codex', displayName: 'Codex', start: 10, length: 6 },
        { type: 'participant', participantId: 'claude', displayName: 'Claude Code', start: 19, length: 12 },
      ],
    })
  })

  it('keeps repeated picker selections for the same participant as distinct chain steps', () => {
    const first = applyMentionSelection('@He', [], 0, 3, {
      type: 'agent', participantId: 'hermes', name: 'Hermes',
    })
    const secondText = `${first.text}→ @He`
    const second = applyMentionSelection(secondText, first.mentions, first.text.length + 2, secondText.length, {
      type: 'agent', participantId: 'hermes', name: 'Hermes',
    })

    expect(second.text).toBe('@Hermes → @Hermes ')
    expect(second.mentions).toEqual([
      { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 0, length: 7 },
      { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 10, length: 7 },
    ])
  })

  it('allows the same participant to appear repeatedly in a finite chain', () => {
    const agents = [
      { agentId: 'hermes', name: 'Hermes' },
      { agentId: 'codex', name: 'Codex' },
    ]
    expect(structuredChainForSubmission('@Hermes → @Codex → @Hermes compare', [], agents)).toEqual({
      version: 1,
      participants: [
        { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 0, length: 7 },
        { type: 'participant', participantId: 'codex', displayName: 'Codex', start: 10, length: 6 },
        { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 19, length: 7 },
      ],
    })
    expect(structuredChainForSubmission('@Hermes → @Hermes compare', [], agents)?.participants.map(participant => participant.participantId)).toEqual([
      'hermes', 'hermes',
    ])
  })

  it('does not reinterpret ordinary multiple mentions and rejects invalid fixed-chain intent', () => {
    const agents = [{ agentId: 'hermes', name: 'Hermes' }, { agentId: 'codex', name: 'Codex' }]
    expect(structuredChainForSubmission('@Hermes and @Codex compare', [], agents)).toBeUndefined()
    expect(structuredChainForSubmission('@Hermes compare A -> B', [], agents)).toBeUndefined()
    expect(structuredChainForSubmission('@Hermes compare A -> @Codex', [], agents)).toBeUndefined()
    expect(() => structuredChainForSubmission('@all → @Codex compare', [], agents)).toThrow(/invalid participant chain/i)
    expect(() => structuredChainForSubmission('@Hermes → @Missing compare', [], agents)).toThrow(/invalid participant chain/i)
  })

  it('deduplicates repeated participant entities only at ordinary mention submission', () => {
    expect(mentionsForSubmission([
      { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 0, length: 7 },
      { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 12, length: 7 },
    ])).toEqual([
      { type: 'participant', participantId: 'hermes', displayName: 'Hermes', start: 0, length: 7 },
    ])
  })

  it('preserves picker-backed entities when preparing a submission', () => {
    expect(mentionsForSubmission([worker])).toEqual([worker])
  })
})
