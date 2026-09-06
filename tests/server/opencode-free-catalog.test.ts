import { afterEach, expect, it, vi } from 'vitest'
import { fetchOpenCodeFreeModels } from '../../packages/server/src/modules/studio/public/provider-catalog'

afterEach(() => vi.unstubAllGlobals())

it('fetches anonymously and excludes paid models and the Go-only free-named twin', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'mimo-v2.5-free' }, { id: 'deepseek-v4-flash-free' },
    { id: 'claude-opus-4-8' }, { id: 'ox-alpha-free' }, { id: 'openrouter/free' },
  ] })))
  vi.stubGlobal('fetch', fetchMock)
  expect(await fetchOpenCodeFreeModels()).toEqual(['deepseek-v4-flash-free', 'mimo-v2.5-free'])
  expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/models', expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) }))
})
