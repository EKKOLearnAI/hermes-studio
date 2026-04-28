// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChatApi = vi.hoisted(() => ({
  startRun: vi.fn(),
  streamRunEvents: vi.fn(),
}))

const mockSessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  fetchSessionUsageSingle: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => mockChatApi)
vi.mock('@/api/hermes/sessions', () => mockSessionsApi)

import { useChatStore } from '@/stores/hermes/chat'

const PROFILE = 'default'

async function flush() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

type EventHandler = (evt: any) => void

function setupStream(events: Array<any>) {
  mockChatApi.streamRunEvents.mockImplementation((
    _runId: string,
    onEvent: EventHandler,
  ) => {
    // Fire events synchronously on microtask queue so they land on the
    // same streaming message that sendMessage just created.
    queueMicrotask(() => {
      for (const e of events) onEvent(e)
    })
    return { abort: vi.fn() }
  })
}

describe('chat store — reasoning.available should not clobber content', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.localStorage.clear()
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)
    mockSessionsApi.fetchSessionUsageSingle?.mockResolvedValue?.(null)
    mockChatApi.startRun.mockResolvedValue({ run_id: 'run-1', status: 'queued' })
  })

  it('keeps streamed reasoning.delta when a later reasoning.available carries the assistant content (upstream bug)', async () => {
    // Simulates the bug path from hermes-agent run_agent.py:11275, which
    // fires reasoning.available with `assistant_message.content[:500]` as
    // the preview — i.e., the *main answer*, not real reasoning.
    // The store must not replace the already-accumulated reasoning with
    // the content payload.
    setupStream([
      { event: 'run.started', run_id: 'run-1' },
      { event: 'reasoning.delta', run_id: 'run-1', text: 'Let me think ' },
      { event: 'reasoning.delta', run_id: 'run-1', text: 'about this.' },
      { event: 'message.delta', run_id: 'run-1', delta: 'The answer is 42.' },
      // Upstream misclassification: text == the assistant content
      { event: 'reasoning.available', run_id: 'run-1', text: 'The answer is 42.' },
      { event: 'run.completed', run_id: 'run-1' },
    ])

    const store = useChatStore()
    await flush()
    await store.sendMessage('hi')
    await flush()
    await flush()

    const asst = store.messages.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()
    expect(asst!.content).toBe('The answer is 42.')
    expect(asst!.reasoning).toBe('Let me think about this.')
  })

  it('also rejects reasoning.available when delta-less stream already flushed content', async () => {
    // Upstream main (no PR #15169) does not emit reasoning.delta at all.
    // The only reasoning-flavored event is the misclassified reasoning.available
    // carrying content as the text. We still must not write it into the
    // thinking block, because content has already arrived — that's a strong
    // signal the payload is the content-misclassification bug.
    setupStream([
      { event: 'run.started', run_id: 'run-1' },
      { event: 'message.delta', run_id: 'run-1', delta: 'Plain answer.' },
      { event: 'reasoning.available', run_id: 'run-1', text: 'Plain answer.' },
      { event: 'run.completed', run_id: 'run-1' },
    ])

    const store = useChatStore()
    await flush()
    await store.sendMessage('hi')
    await flush()
    await flush()

    const asst = store.messages.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()
    expect(asst!.content).toBe('Plain answer.')
    // No delta events arrived and content already present → still must not
    // hijack the thinking block. Leave it empty so the UI simply doesn't show
    // a thinking block (better than showing the answer twice).
    expect(asst!.reasoning ?? '').toBe('')
  })

  it('marks reasoning end-of-thinking observation even when the payload is ignored', async () => {
    // We drop reasoning.available's text payload because upstream misclassifies
    // content as reasoning preview (see run_agent.py:11275). But we still want
    // the event to serve as an "end-of-thinking" signal so the UI can stop
    // the thinking-duration counter for messages that had reasoning.delta.
    setupStream([
      { event: 'run.started', run_id: 'run-1' },
      { event: 'reasoning.delta', run_id: 'run-1', text: 'pondering…' },
      { event: 'message.delta', run_id: 'run-1', delta: 'done' },
      { event: 'reasoning.available', run_id: 'run-1', text: 'done' },
      { event: 'run.completed', run_id: 'run-1' },
    ])

    const store = useChatStore()
    await flush()
    await store.sendMessage('hi')
    await flush()
    await flush()

    const asst = store.messages.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()
    // reasoning preserved (not clobbered)
    expect(asst!.reasoning).toBe('pondering…')
    // thinking observation must have endedAt stamped
    const ob = store.getThinkingObservation(asst!.id)
    expect(ob?.endedAt).toBeDefined()
  })

  it('heals old localStorage cache where reasoning was clobbered with content', async () => {
    // Users who ran the previous buggy version have sessions in
    // localStorage where assistant.reasoning === assistant.content (or
    // reasoning is a prefix of content because the bug truncated to 500
    // chars). Hydration must drop such stale reasoning so the UI doesn't
    // flash the wrong thinking block before fetchSession completes.
    const sid = 'sess-cache'
    window.localStorage.setItem(`hermes_active_session_${PROFILE}`, sid)
    window.localStorage.setItem(
      `hermes_sessions_cache_v1_${PROFILE}`,
      JSON.stringify([
        {
          id: sid,
          title: 'Corrupted',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )
    window.localStorage.setItem(
      `hermes_session_msgs_v1_${PROFILE}_${sid}_`,
      JSON.stringify([
        { id: 'u', role: 'user', content: 'ask', timestamp: 1 },
        {
          id: 'a',
          role: 'assistant',
          content: 'The capital of France is Paris. It sits on the Seine.',
          reasoning: 'The capital of France is Paris.', // prefix of content — buggy
          timestamp: 2,
        },
        {
          id: 'b',
          role: 'assistant',
          content: 'Another answer.',
          reasoning: 'Real thinking that happens before the answer.', // legitimate
          timestamp: 3,
        },
      ]),
    )

    const store = useChatStore()
    await store.loadSessions()

    const hydrated = store.messages
    const a = hydrated.find(m => m.id === 'a')!
    const b = hydrated.find(m => m.id === 'b')!
    expect(a.reasoning).toBeUndefined()
    expect(b.reasoning).toBe('Real thinking that happens before the answer.')
  })
})
