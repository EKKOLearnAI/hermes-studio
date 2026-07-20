import { beforeEach, describe, expect, it, vi } from 'vitest'

const listSkillBundlesMock = vi.hoisted(() => vi.fn())
const createSkillBundleMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
}))

vi.mock('../../packages/server/src/services/hermes/skill-bundles', () => ({
  listSkillBundles: listSkillBundlesMock,
  createSkillBundle: createSkillBundleMock,
  deleteSkillBundle: deleteSkillBundleMock,
  SkillBundleValidationError: class SkillBundleValidationError extends Error {},
  SkillBundleConflictError: class SkillBundleConflictError extends Error {},
  SkillBundleProfileNotFoundError: class SkillBundleProfileNotFoundError extends Error {},
  SkillBundleNotFoundError: class SkillBundleNotFoundError extends Error {},
}))

describe('skill bundles controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists bundles using the request-scoped profile', async () => {
    const bundles = [{ name: 'Review', commandName: 'review', description: '', skills: ['github'] }]
    listSkillBundlesMock.mockResolvedValue(bundles)
    const { list } = await import('../../packages/server/src/controllers/hermes/skill-bundles')
    const ctx: any = { query: {}, state: { profile: { name: 'work' } }, body: null }

    await list(ctx)

    expect(listSkillBundlesMock).toHaveBeenCalledWith('work')
    expect(ctx.body).toEqual({ bundles })
  })

  it('creates bundles using the request-scoped profile', async () => {
    const bundle = { name: 'Review', commandName: 'review', description: 'PR checks', skills: ['github'] }
    createSkillBundleMock.mockResolvedValue(bundle)
    const { create } = await import('../../packages/server/src/controllers/hermes/skill-bundles')
    const ctx: any = {
      query: {},
      state: { profile: { name: 'work' } },
      request: { body: { name: 'Review', description: 'PR checks', skills: ['github'] } },
      body: null,
      status: 200,
    }

    await create(ctx)

    expect(createSkillBundleMock).toHaveBeenCalledWith('work', {
      name: 'Review',
      description: 'PR checks',
      skills: ['github'],
    })
    expect(ctx.status).toBe(201)
    expect(ctx.body).toEqual({ bundle })
  })

  it('deletes bundles using the request-scoped profile', async () => {
    deleteSkillBundleMock.mockResolvedValue(undefined)
    const { remove } = await import('../../packages/server/src/controllers/hermes/skill-bundles')
    const ctx: any = {
      query: {},
      params: { commandName: 'review-team' },
      state: { profile: { name: 'work' } },
      body: null,
    }

    await remove(ctx)

    expect(deleteSkillBundleMock).toHaveBeenCalledWith('work', 'review-team')
    expect(ctx.body).toEqual({ success: true })
  })
})
