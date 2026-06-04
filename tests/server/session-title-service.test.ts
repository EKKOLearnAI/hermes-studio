import { describe, expect, it } from 'vitest'

import { generateBestSessionTitle, generateHeuristicSessionTitle, generateInitialSessionTitle, generateLlmSessionTitle, NEW_CHAT_TITLE } from '../../packages/server/src/services/hermes/session-title'

describe('session title service', () => {
  it('uses the first useful user message and skips trivial greetings', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '/status' },
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'Debug the Vite build failing on macOS after upgrading TypeScript' },
    ])

    expect(title).toBe('Debug Vite build on macOS')
  })

  it('prefers a later focused thread topic over an early incidental question', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: '8677这个端口现在是哪个session开的，把ID给我' },
      { role: 'assistant', content: '8677 is opened by proc_24ff68c1b5c7.' },
      { role: 'user', content: 'webui这个重命名首次触发的逻辑是怎样的？另外compactification的时候重命名可能影响用户体验，应该拿掉。' },
      { role: 'assistant', content: 'Explained the WebUI session title flow and removed compaction auto-renames.' },
      { role: 'user', content: '但这边手动 rename 跟 regenerate title 会不会在使用 UX 上有重叠？另外，现在的 title 感觉很长。而且没有抓住这个 session 的要点' },
    ])

    expect(title).toBe('WebUI title UX')
  })

  it('keeps generated titles compact', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: 'Please investigate why the Web UI session rename and regenerate title actions overlap in the context menu and propose a cleaner UX.' },
    ])

    expect(title).toBe('Web UI session title UX')
    expect(title.length).toBeLessThanOrEqual(48)
  })

  it('uses New Chat as the initial placeholder before the first response title finalization', () => {
    const title = generateInitialSessionTitle(
      'Please investigate why the Web UI session rename and regenerate title actions overlap in the context menu and propose a cleaner UX.',
    )

    expect(title).toBe(NEW_CHAT_TITLE)
  })

  it('compacts casual Chinese weather chat instead of echoing the full first message', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: '今天的天气不错哦，聊一聊呗' },
      { role: 'assistant', content: '这种日子适合散步、坐在外面喝点东西，或者做一点低压力的计划。' },
    ])

    expect(title).toBe('好天气闲聊')
  })

  it('falls back to the first assistant message when no useful user message exists', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'Reviewed the deployment logs and found a missing DATABASE_URL env var.' },
    ])

    expect(title).toBe('Reviewed Deployment Logs Found Missing')
  })

  it('falls back to the existing title when no usable message content exists', () => {
    const title = generateHeuristicSessionTitle([
      { role: 'tool', content: '' },
      { role: 'assistant', content: '```ts\nconst value = 1\n```' },
    ], 'Existing title')

    expect(title).toBe('Existing title')
  })

  it('generates a concise LLM-backed title from first-turn conversation context', async () => {
    const requests: any[] = []
    const bridge = {
      request: async (payload: any) => {
        requests.push(payload)
        return {
          status: 'completed',
          run_id: 'run-title',
          session_id: payload.session_id,
          output: 'Title: WebUI title UX',
          deltas: [],
          events: [],
        }
      },
      destroy: async () => undefined,
    }

    const title = await generateLlmSessionTitle({
      messages: [
        { role: 'user', content: 'The title UX is confusing: rename and regenerate overlap.' },
        { role: 'assistant', content: 'Move suggestions into the rename dialog and keep manual confirmation.' },
      ],
      bridge,
      profile: 'default',
      model: 'gpt-test',
      provider: 'test-provider',
    })

    expect(title).toBe('WebUI title UX')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      action: 'chat',
      profile: 'default',
      model: 'gpt-test',
      provider: 'test-provider',
      source: 'internal_title_generation',
      wait: true,
    })
    expect(requests[0].instructions).toContain('Return exactly one title')
    expect(requests[0].conversation_history).toEqual([
      { role: 'user', content: 'The title UX is confusing: rename and regenerate overlap.' },
      { role: 'assistant', content: 'Move suggestions into the rename dialog and keep manual confirmation.' },
    ])
  })

  it('falls back to a heuristic title when LLM title generation fails', async () => {
    const bridge = {
      request: async () => ({
        status: 'error',
        run_id: 'run-title',
        session_id: 'title-session',
        output: '',
        deltas: [],
        events: [],
        error: 'provider failed',
      }),
      destroy: async () => undefined,
    }

    const result = await generateBestSessionTitle({
      messages: [{ role: 'user', content: 'Please investigate compaction title behavior.' }],
      bridge,
    })

    expect(result).toEqual({
      title: 'Investigate compaction title behavior',
      source: 'heuristic',
    })
  })
})
