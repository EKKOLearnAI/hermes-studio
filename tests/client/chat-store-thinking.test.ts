// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'

describe('chat store thinkingObservation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const store = useChatStore()
    expect(store.getThinkingObservation('any-id')).toBeUndefined()
  })

  it('records startedAt when delta first introduces an opening tag', () => {
    const store = useChatStore()
    store.noteThinkingDelta('msg-1', '', '<think>hi')
    const ob = store.getThinkingObservation('msg-1')
    expect(ob).toBeDefined()
    expect(typeof ob!.startedAt).toBe('number')
    expect(ob!.endedAt).toBeUndefined()
  })

  it('records endedAt when delta first introduces closing tag', () => {
    const store = useChatStore()
    store.noteThinkingDelta('msg-1', '', '<think>hi')
    store.noteThinkingDelta('msg-1', '<think>hi', '<think>hi</think>done')
    const ob = store.getThinkingObservation('msg-1')
    expect(ob!.startedAt).toBeDefined()
    expect(typeof ob!.endedAt).toBe('number')
  })

  it('is idempotent for subsequent openings/closings', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '<think>a</think>')
    const first = store.getThinkingObservation('m')!
    const firstStarted = first.startedAt
    const firstEnded = first.endedAt
    store.noteThinkingDelta(
      'm',
      '<think>a</think>',
      '<think>a</think><think>b</think>',
    )
    const second = store.getThinkingObservation('m')!
    expect(second.startedAt).toBe(firstStarted)
    expect(second.endedAt).toBe(firstEnded)
  })

  it('is ignored when delta is inside a code block', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '```\n<think>fake</think>\n```')
    expect(store.getThinkingObservation('m')).toBeUndefined()
  })

  it('clears observations on clearThinkingObservationFor', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '<think>hi</think>')
    expect(store.getThinkingObservation('m')).toBeDefined()
    store.clearThinkingObservationFor('any-session')
    expect(store.getThinkingObservation('m')).toBeUndefined()
  })

  it('noteReasoningStart records startedAt only once', () => {
    const store = useChatStore()
    store.noteReasoningStart('r1')
    const t1 = store.getThinkingObservation('r1')!.startedAt
    expect(typeof t1).toBe('number')
    store.noteReasoningStart('r1')
    expect(store.getThinkingObservation('r1')!.startedAt).toBe(t1)
  })

  it('noteReasoningEnd requires prior start', () => {
    const store = useChatStore()
    store.noteReasoningEnd('r2')
    expect(store.getThinkingObservation('r2')).toBeUndefined()
    store.noteReasoningStart('r2')
    store.noteReasoningEnd('r2')
    expect(store.getThinkingObservation('r2')!.endedAt).toBeDefined()
  })

  it('noteReasoningEnd is idempotent', () => {
    const store = useChatStore()
    store.noteReasoningStart('r3')
    store.noteReasoningEnd('r3')
    const end1 = store.getThinkingObservation('r3')!.endedAt
    store.noteReasoningEnd('r3')
    expect(store.getThinkingObservation('r3')!.endedAt).toBe(end1)
  })
})
