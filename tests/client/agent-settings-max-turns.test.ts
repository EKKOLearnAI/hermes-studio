import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AgentSettings maximum turns', () => {
  it('does not impose a Studio-specific upper limit', () => {
    const source = readFileSync(
      'packages/client/src/components/hermes/settings/AgentSettings.vue',
      'utf8',
    )
    const maxTurnsInput = source.match(
      /<NInputNumber\s+[\s\S]*?:value="settingsStore\.agent\.max_turns"[\s\S]*?\/>/,
    )?.[0]

    expect(maxTurnsInput).toBeDefined()
    expect(maxTurnsInput).not.toMatch(/:max=/)
    expect(maxTurnsInput).toContain(':min="1"')
  })
})
