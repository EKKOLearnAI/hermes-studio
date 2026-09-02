import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
  getApiKey: vi.fn(() => ''),
  getBaseUrlValue: vi.fn(() => ''),
  getActiveProfileName: vi.fn(() => null),
}))

import { fetchSkillContent, fetchSkillFiles } from '../../packages/client/src/api/hermes/skills'

describe('Skills API paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('encodes reserved characters in skill content path segments', async () => {
    mockRequest.mockResolvedValue({ content: '# C# helper' })

    await expect(fetchSkillContent('languages/C#/SKILL.md')).resolves.toBe('# C# helper')

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/skills/languages/C%23/SKILL.md')
  })

  it('encodes nested file paths without encoding their separators', async () => {
    mockRequest.mockResolvedValue({ content: 'reference' })

    await fetchSkillContent('misc/why?/references/section#1.md', 'codex')

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/hermes/skills/misc/why%3F/references/section%231.md?target=codex',
    )
  })

  it('encodes reserved characters in category and skill names when listing files', async () => {
    mockRequest.mockResolvedValue({ files: [] })

    await expect(fetchSkillFiles('language#tools', 'why?', 'pi')).resolves.toEqual([])

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/hermes/skills/language%23tools/why%3F/files?target=pi',
    )
  })
})
