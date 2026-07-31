import { describe, expect, it } from 'vitest'
import {
  applyMentionSelection,
  mentionsForSubmission,
  reconcileMentionEdit,
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

  it('preserves picker-backed entities when preparing a submission', () => {
    expect(mentionsForSubmission([worker])).toEqual([worker])
  })
})
