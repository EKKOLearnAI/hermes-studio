import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecHermes = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermes: mockExecHermes,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (name: string) => `/hermes/${name || 'default'}`,
}))

describe('hermes journey service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads the journey graph through the CLI with color disabled and profile env', async () => {
    mockExecHermes.mockResolvedValueOnce({
      stdout: '\u001b[1m{"nodes":[{"id":"skill-a","label":"Skill A","kind":"skill"}],"edges":[],"clusters":[],"stats":{"learned_skills":1}}\u001b[0m\n',
      stderr: '',
    })

    const { getJourneyGraph } = await import('../../packages/server/src/services/hermes/journey')
    await expect(getJourneyGraph('work')).resolves.toEqual({
      profile: 'work',
      source: 'cli',
      graph: {
        nodes: [{ id: 'skill-a', label: 'Skill A', kind: 'skill' }],
        edges: [],
        clusters: [],
        memory: [],
        stats: { learned_skills: 1 },
      },
    })

    expect(mockExecHermes).toHaveBeenCalledWith(['journey', '--json', '--no-color'], expect.objectContaining({
      timeout: 10000,
      env: expect.objectContaining({ HERMES_HOME: '/hermes/work' }),
    }))
  })

  it('surfaces invalid JSON clearly', async () => {
    mockExecHermes.mockResolvedValueOnce({ stdout: 'not json', stderr: '' })

    const { getJourneyGraph } = await import('../../packages/server/src/services/hermes/journey')
    await expect(getJourneyGraph('default')).rejects.toThrow('Hermes journey returned invalid JSON')
  })

  it('asks users to update Hermes when the journey command is unsupported', async () => {
    mockExecHermes.mockRejectedValueOnce(Object.assign(new Error('exit 2'), {
      stderr: "usage: hermes [-h] {chat,config}\nhermes: error: argument command: invalid choice: 'journey'",
    }))

    const { getJourneyGraph } = await import('../../packages/server/src/services/hermes/journey')
    await expect(getJourneyGraph('default')).rejects.toThrow('Please update Hermes to 0.18.0 or later to use Learning Journey.')
  })

  it('keeps non-version CLI errors actionable', async () => {
    mockExecHermes.mockRejectedValueOnce(Object.assign(new Error('exit 1'), {
      stderr: 'database is locked',
    }))

    const { getJourneyGraph } = await import('../../packages/server/src/services/hermes/journey')
    await expect(getJourneyGraph('default')).rejects.toThrow('Failed to load Hermes journey graph: database is locked')
  })
})
