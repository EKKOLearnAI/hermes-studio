import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type FsMocks = {
  readFile: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
  mkdir: ReturnType<typeof vi.fn>
}

async function loadAuth(overrides: Partial<FsMocks> & { home?: string } = {}) {
  const readFile = overrides.readFile ?? vi.fn()
  const writeFile = overrides.writeFile ?? vi.fn()
  const mkdir = overrides.mkdir ?? vi.fn()
  const home = overrides.home ?? '/tmp/hermes-home'

  vi.resetModules()
  vi.doMock('fs/promises', () => ({ readFile, writeFile, mkdir }))
  vi.doMock('os', () => ({ homedir: () => home }))

  const mod = await import('../../packages/server/src/services/auth')
  return {
    ...mod,
    mocks: { readFile, writeFile, mkdir },
    appHome: `${home}/.hermes-web-ui`,
    tokenFile: `${home}/.hermes-web-ui/.token`,
  }
}

function createMockCtx(path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return {
    path,
    headers,
    query,
    status: 200,
    body: null,
    set: vi.fn(),
  }
}

describe('Auth Service', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('getToken', () => {
    it('returns null when AUTH_DISABLED=1', async () => {
      process.env.AUTH_DISABLED = '1'
      const { getToken, mocks } = await loadAuth()

      const token = await getToken()

      expect(token).toBeNull()
      expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('returns null when AUTH_DISABLED=true', async () => {
      process.env.AUTH_DISABLED = 'true'
      const { getToken } = await loadAuth()

      await expect(getToken()).resolves.toBeNull()
    })

    it('returns AUTH_TOKEN env var if set', async () => {
      process.env.AUTH_TOKEN = 'my-custom-token'
      const { getToken, mocks } = await loadAuth()

      const token = await getToken()

      expect(token).toBe('my-custom-token')
      expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('reads token from file if it exists', async () => {
      const readFile = vi.fn().mockResolvedValue('file-token\n')
      const { getToken, tokenFile } = await loadAuth({ readFile })

      const token = await getToken()

      expect(token).toBe('file-token')
      expect(readFile).toHaveBeenCalledWith(tokenFile, 'utf-8')
    })

    it('generates and saves a token if the token file is missing', async () => {
      const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'))
      const writeFile = vi.fn()
      const mkdir = vi.fn()
      const { getToken, appHome, tokenFile } = await loadAuth({ readFile, writeFile, mkdir })

      const token = await getToken()

      expect(token).toMatch(/^[a-f0-9]{64}$/)
      expect(mkdir).toHaveBeenCalledWith(appHome, { recursive: true })
      expect(writeFile).toHaveBeenCalledWith(
        tokenFile,
        expect.stringMatching(/^[a-f0-9]{64}\n$/),
        { mode: 0o600 },
      )
    })
  })

  describe('requireAuth', () => {
    it('allows all requests when auth is disabled (null token)', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth(null)
      const ctx = createMockCtx('/api/hermes/sessions')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('skips /health', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/health')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('skips /webhook because it is treated as a public non-API path', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/webhook')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('skips non-API paths', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/index.html')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
      expect(ctx.status).toBe(200)
    })

    it('requires auth for /upload', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/upload')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
      expect(next).not.toHaveBeenCalled()
    })

    it('rejects request without auth header for protected API routes', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/api/hermes/sessions')
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('rejects request with the wrong bearer token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer wrong' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('allows request with the correct bearer token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer secret' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('allows request with the correct query token', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/api/hermes/sessions', {}, { token: 'secret' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(next).toHaveBeenCalledOnce()
    })

    it('returns 401 JSON on auth failure', async () => {
      const { requireAuth } = await loadAuth()
      const middleware = requireAuth('secret')
      const ctx = createMockCtx('/api/hermes/sessions', { authorization: 'Bearer wrong' })
      const next = vi.fn(async () => {})

      await middleware(ctx, next)

      expect(ctx.status).toBe(401)
      expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })
})
