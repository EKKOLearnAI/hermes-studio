import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock os.homedir before imports so file path resolution is stable.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => '/fake/home' }
})

const { mockReadFile, mockExecFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockExecFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({ readFile: mockReadFile }))
vi.mock('child_process', () => ({ execFile: mockExecFile }))

import {
  resolveCopilotOAuthToken,
  getCopilotModels,
  getCopilotModelsDetailed,
  COPILOT_FALLBACK_MODELS,
  __resetCopilotModelsCacheForTest,
} from '../../packages/server/src/services/hermes/copilot-models'

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = global.fetch

function clearTokenEnv() {
  delete process.env.COPILOT_GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
}

beforeEach(() => {
  __resetCopilotModelsCacheForTest()
  vi.clearAllMocks()
  clearTokenEnv()
  // Default: apps.json read fails (ENOENT)
  mockReadFile.mockRejectedValue(new Error('ENOENT'))
  // Default: gh CLI fails
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(new Error('gh not installed'), { stdout: '', stderr: '' })
  })
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  global.fetch = ORIGINAL_FETCH
})

describe('resolveCopilotOAuthToken', () => {
  it('优先级：COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'gho_copilot'
    process.env.GH_TOKEN = 'gho_gh'
    process.env.GITHUB_TOKEN = 'gho_github'
    expect(await resolveCopilotOAuthToken('')).toBe('gho_copilot')

    delete process.env.COPILOT_GITHUB_TOKEN
    expect(await resolveCopilotOAuthToken('')).toBe('gho_gh')

    delete process.env.GH_TOKEN
    expect(await resolveCopilotOAuthToken('')).toBe('gho_github')
  })

  it('跳过 classic PAT (ghp_)，回退到下一来源', async () => {
    process.env.GH_TOKEN = 'ghp_classic_pat'
    process.env.GITHUB_TOKEN = 'gho_oauth_token'
    expect(await resolveCopilotOAuthToken('')).toBe('gho_oauth_token')
  })

  it('从 .env 读取并去掉两端引号', async () => {
    expect(await resolveCopilotOAuthToken('GH_TOKEN="gho_quoted"\n')).toBe('gho_quoted')
    expect(await resolveCopilotOAuthToken("GH_TOKEN='gho_single'\n")).toBe('gho_single')
    expect(await resolveCopilotOAuthToken('GH_TOKEN=gho_plain\n')).toBe('gho_plain')
  })

  it('忽略 .env 中以 # 开头的注释行', async () => {
    expect(await resolveCopilotOAuthToken('GH_TOKEN=# comment\n')).toBe('')
  })

  it('回退到 ~/.config/github-copilot/apps.json 的 oauth_token', async () => {
    mockReadFile.mockImplementation(async (p: string) => {
      if (p.includes('apps.json')) {
        return JSON.stringify({
          'github.com:abc': { oauth_token: 'gho_from_apps_json', user: 'me' },
        })
      }
      throw new Error('ENOENT')
    })
    expect(await resolveCopilotOAuthToken('')).toBe('gho_from_apps_json')
  })

  it('apps.json 中的 ghp_ token 也应跳过', async () => {
    mockReadFile.mockImplementation(async (p: string) => {
      if (p.includes('apps.json')) {
        return JSON.stringify({ 'github.com:a': { oauth_token: 'ghp_pat_in_apps' } })
      }
      throw new Error('ENOENT')
    })
    expect(await resolveCopilotOAuthToken('')).toBe('')
  })

  it('最后回退到 `gh auth token`', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, { stdout: 'gho_from_gh_cli\n', stderr: '' })
    })
    expect(await resolveCopilotOAuthToken('')).toBe('gho_from_gh_cli')
  })

  it('所有来源都失败时返回空字符串', async () => {
    expect(await resolveCopilotOAuthToken('')).toBe('')
  })
})

describe('getCopilotModels', () => {
  function mockFetchSequence(responses: Array<Partial<Response> | Error>) {
    let i = 0
    global.fetch = vi.fn(async () => {
      const r = responses[i++]
      if (r instanceof Error) throw r
      return r as Response
    }) as any
  }

  it('成功路径：返回 chat type 且 supports /chat/completions 的模型 id', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok_copilot' }) } as any,
      {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-5.4', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'claude-opus-4.7', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions', '/v1/messages'] },
            { id: 'embedding-1', capabilities: { type: 'embeddings' }, supported_endpoints: ['/embeddings'] },
            { id: 'completion-only', capabilities: { type: 'chat' }, supported_endpoints: ['/completions'] },
            { id: 'no-endpoints', capabilities: { type: 'chat' } },
          ],
        }),
      } as any,
    ])
    const ids = await getCopilotModels('')
    expect(ids).toContain('gpt-5.4')
    expect(ids).toContain('claude-opus-4.7')
    expect(ids).toContain('no-endpoints') // endpoints 缺省时允许
    expect(ids).not.toContain('embedding-1')
    expect(ids).not.toContain('completion-only')
  })

  it('不再强制 model_picker_enabled —— picker_enabled=false 的模型也返回', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok' }) } as any,
      {
        ok: true,
        json: async () => ({
          data: [
            { id: 'a', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'], model_picker_enabled: false },
            { id: 'b', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'], model_picker_enabled: true },
          ],
        }),
      } as any,
    ])
    const ids = await getCopilotModels('')
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('无 token 时返回 fallback 列表', async () => {
    const ids = await getCopilotModels('')
    expect(ids).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
  })

  it('token exchange 失败返回 fallback', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([{ ok: false, status: 401 } as any])
    const ids = await getCopilotModels('')
    expect(ids).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
  })

  it('models endpoint 失败返回 fallback', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok' }) } as any,
      { ok: false, status: 503 } as any,
    ])
    const ids = await getCopilotModels('')
    expect(ids).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
  })

  it('网络错误（如超时）返回 fallback', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([new Error('AbortError: timeout')])
    const ids = await getCopilotModels('')
    expect(ids).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
  })

  it('正缓存命中：第二次调用不再发请求', async () => {
    process.env.GH_TOKEN = 'gho_token'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'm1', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] }] }),
      })
    global.fetch = fetchMock as any
    const a = await getCopilotModels('')
    const b = await getCopilotModels('')
    expect(a).toEqual(['m1'])
    expect(b).toEqual(['m1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('负缓存：失败后短期内不再重试', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as any
    const a = await getCopilotModels('')
    const b = await getCopilotModels('')
    expect(a).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
    expect(b).toEqual(COPILOT_FALLBACK_MODELS.map(m => m.id))
    // 无 token 时根本不会调 fetch
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('并发请求合并：同时调用 N 次只发一组请求', async () => {
    process.env.GH_TOKEN = 'gho_token'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'x', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] }] }),
      })
    global.fetch = fetchMock as any
    const [a, b, c] = await Promise.all([
      getCopilotModels(''),
      getCopilotModels(''),
      getCopilotModels(''),
    ])
    expect(a).toEqual(['x'])
    expect(b).toEqual(['x'])
    expect(c).toEqual(['x'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('getCopilotModels noise filter & detailed meta', () => {
  function mockFetchSequence(responses: Array<Partial<Response> | Error>) {
    let i = 0
    global.fetch = vi.fn(async () => {
      const r = responses[i++]
      if (r instanceof Error) throw r
      return r as Response
    }) as any
  }

  it('过滤掉噪音 ID（accounts/、text-embedding、rerank 前缀）', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok' }) } as any,
      {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-5.4', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'accounts/msft/routers/abc', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'text-embedding-3-small', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'rerank-v1', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
          ],
        }),
      } as any,
    ])
    const ids = await getCopilotModels('')
    expect(ids).toEqual(['gpt-5.4'])
  })

  it('detailed 返回 preview 字段', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok' }) } as any,
      {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gemini-3-pro-preview', preview: true, capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-4o', preview: false, capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
          ],
        }),
      } as any,
    ])
    const detailed = await getCopilotModelsDetailed('')
    expect(detailed).toEqual([
      { id: 'gemini-3-pro-preview', preview: true, disabled: false },
      { id: 'gpt-4o', preview: false, disabled: false },
    ])
  })

  it('detailed 返回 disabled 字段（policy.state === "disabled"）', async () => {
    process.env.GH_TOKEN = 'gho_token'
    mockFetchSequence([
      { ok: true, json: async () => ({ token: 'tok' }) } as any,
      {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-3.5-turbo', policy: { state: 'disabled' }, capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-4o', policy: { state: 'enabled' }, capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
            { id: 'claude-sonnet-4', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
          ],
        }),
      } as any,
    ])
    const detailed = await getCopilotModelsDetailed('')
    const map = new Map(detailed.map((m) => [m.id, m]))
    expect(map.get('gpt-3.5-turbo')?.disabled).toBe(true)
    expect(map.get('gpt-4o')?.disabled).toBe(false)
    expect(map.get('claude-sonnet-4')?.disabled).toBe(false)
  })

  it('缓存按 oauth token 隔离：切换账号会重新拉取', async () => {
    const fetchMock = vi.fn()
      // 账号 A：token exchange + models
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'tokA' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'model-a', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] }] }),
      })
      // 账号 B：另一组 token exchange + models
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'tokB' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'model-b', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] }] }),
      })
    global.fetch = fetchMock as any

    process.env.GH_TOKEN = 'gho_account_A'
    const a = await getCopilotModels('')
    expect(a).toEqual(['model-a'])

    // 切换到账号 B，不 reset cache
    process.env.GH_TOKEN = 'gho_account_B'
    const b = await getCopilotModels('')
    expect(b).toEqual(['model-b'])

    // 再切回 A：应该命中 A 的缓存（不再发请求）
    process.env.GH_TOKEN = 'gho_account_A'
    const a2 = await getCopilotModels('')
    expect(a2).toEqual(['model-a'])

    // 总共 4 次请求（A.exchange、A.models、B.exchange、B.models），切回 A 时命中缓存
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
