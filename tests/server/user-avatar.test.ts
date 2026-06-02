import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('user avatar storage and controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.doUnmock('../../packages/server/src/services/hermes/hermes-profile')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function initUsers() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      users: await import('../../packages/server/src/db/hermes/users-store'),
      ctrl: await import('../../packages/server/src/controllers/auth'),
    }
  }

  function makeControllerCtx(user: any | null | undefined, body: any = {}) {
    return {
      state: user ? { user } : {},
      request: { body },
      status: 200,
      body: null,
    } as any
  }

  describe('users-store avatar helpers', () => {
    it('returns an empty string for a brand new user', async () => {
      const { users } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      expect(users.getUserAvatar(admin.id)).toBe('')
    })

    it('round-trips avatar JSON through set/getUserAvatar', async () => {
      const { users } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const payload = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,AAA' })

      const ok = users.setUserAvatar(admin.id, payload)
      expect(ok).toBe(true)
      expect(users.getUserAvatar(admin.id)).toBe(payload)
    })

    it('setUserAvatar returns false when the user does not exist', async () => {
      const { users } = await initUsers()
      // create a user so the table exists, but use a clearly non-existent id
      users.bootstrapDefaultSuperAdmin('admin', '123456')

      expect(users.setUserAvatar(9999, '{"type":"default"}')).toBe(false)
      expect(users.getUserAvatar(9999)).toBe('')
    })

    it('setUserAvatar returns false when given a non-numeric userId', async () => {
      const { users } = await initUsers()
      users.bootstrapDefaultSuperAdmin('admin', '123456')

      expect(users.setUserAvatar('not-a-number', '{"type":"default"}')).toBe(false)
      expect(users.setUserAvatar(-1, '{"type":"default"}')).toBe(false)
      expect(users.setUserAvatar(0, '{"type":"default"}')).toBe(false)
    })

    it('persists the avatar in the users table', async () => {
      const { users, schemas } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const payload = JSON.stringify({ type: 'default' })

      users.setUserAvatar(admin.id, payload)

      const row = db
        .prepare(`SELECT avatar FROM ${schemas.USERS_TABLE} WHERE id = ?`)
        .get(admin.id) as { avatar?: string }
      expect(row?.avatar).toBe(payload)
    })
  })

  describe('getMyAvatar controller', () => {
    it('returns 401 when the request is unauthenticated', async () => {
      const { ctrl } = await initUsers()
      const ctx = makeControllerCtx(null)

      await ctrl.getMyAvatar(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })

    it('returns the avatar string for the authenticated user', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const payload = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,HI==' })
      users.setUserAvatar(admin.id, payload)

      const ctx = makeControllerCtx({ id: admin.id, username: 'admin', role: 'super_admin' })
      await ctrl.getMyAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ avatar: payload })
    })

    it('returns an empty avatar string for an authenticated user without an avatar', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      const ctx = makeControllerCtx({ id: admin.id, username: 'admin', role: 'super_admin' })
      await ctrl.getMyAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ avatar: '' })
    })
  })

  describe('updateMyAvatar controller', () => {
    it('persists a default avatar payload sent as a direct object', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'default' },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.success).toBe(true)
      const stored = users.getUserAvatar(admin.id)
      expect(JSON.parse(stored)).toEqual({ type: 'default' })
    })

    it('persists an image avatar payload sent as a direct object', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'image', dataUrl },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.success).toBe(true)
      const stored = users.getUserAvatar(admin.id)
      expect(JSON.parse(stored)).toEqual({ type: 'image', dataUrl })
    })

    it('persists a JSON-string avatar passed in the avatar field', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const serialized = JSON.stringify({ type: 'default', seed: 'abc' })

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { avatar: serialized },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toBe(serialized)
      expect(users.getUserAvatar(admin.id)).toBe(serialized)
    })

    it('rejects an unknown type with HTTP 400', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'emoji', dataUrl: '🦊' },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/image.*default/)
      expect(users.getUserAvatar(admin.id)).toBe('')
    })

    it('rejects an image payload whose dataUrl exceeds 500KB with HTTP 400', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
      const oversized = 'data:image/png;base64,' + 'A'.repeat(500 * 1024 + 16)

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'image', dataUrl: oversized },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/too large|bytes/)
      expect(users.getUserAvatar(admin.id)).toBe('')
    })

    it('rejects an image payload with no dataUrl with HTTP 400', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'image' },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/dataUrl/)
      expect(users.getUserAvatar(admin.id)).toBe('')
    })

    it('rejects an image payload whose dataUrl is not a data URL with HTTP 400', async () => {
      const { users, ctrl } = await initUsers()
      const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!

      const ctx = makeControllerCtx(
        { id: admin.id, username: 'admin', role: 'super_admin' },
        { type: 'image', dataUrl: 'https://example.com/avatar.png' },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/dataUrl/)
    })

    it('rejects a non-object body with HTTP 400', async () => {
      const { ctrl } = await initUsers()

      const ctx = makeControllerCtx(
        { id: 1, username: 'admin', role: 'super_admin' },
        'just-a-string',
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      // A bare string is not valid JSON, so the controller rejects it via the JSON.parse path.
      expect(ctx.body.error).toMatch(/not valid JSON|Invalid avatar payload|too large/)
    })

    it('rejects a malformed JSON string in the avatar field with HTTP 400', async () => {
      const { ctrl } = await initUsers()

      const ctx = makeControllerCtx(
        { id: 1, username: 'admin', role: 'super_admin' },
        { avatar: '{not valid json' },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/not valid JSON|Invalid/)
    })

    it('rejects a non-string seed with HTTP 400', async () => {
      const { ctrl } = await initUsers()

      const ctx = makeControllerCtx(
        { id: 1, username: 'admin', role: 'super_admin' },
        { type: 'default', seed: 123 },
      )
      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toMatch(/seed/)
    })

    it('returns 401 when the request is unauthenticated', async () => {
      const { ctrl } = await initUsers()
      const ctx = makeControllerCtx(null, { type: 'default' })

      await ctrl.updateMyAvatar(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })
})
