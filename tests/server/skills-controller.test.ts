import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockUpdateConfigYamlForProfile = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: mockGetSkillUsageStatsFromDb,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: vi.fn(),
  updateConfigYamlForProfile: mockUpdateConfigYamlForProfile,
  safeReadFile: vi.fn(),
  extractDescription: vi.fn(),
  listFilesRecursive: vi.fn(),
}))

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/controllers/hermes/skills')
}

describe('skills controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActiveProfileName.mockReturnValue('default')
    mockGetProfileDir.mockImplementation((profile: string) => `/tmp/hermes-${profile}`)
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => updater({}))
    mockGetSkillUsageStatsFromDb.mockResolvedValue({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('loads skill usage from the request-scoped profile state database', async () => {
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, state: { profile: { name: 'research' } }, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(30, undefined, 'research')
    expect(ctx.body.period_days).toBe(7)
  })

  it('falls back to active profile when no request profile is set', async () => {
    mockGetActiveProfileName.mockReturnValue('travel')
    const { usageStats } = await loadController()
    const ctx: any = { query: {}, state: {}, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(7, undefined, 'travel')
  })

  it('toggles skills in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { toggle } = await loadController()
    const ctx: any = {
      request: { body: { name: 'new-skill', enabled: false } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await toggle(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill', 'new-skill'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true })
  })
})
