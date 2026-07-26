import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AgentSettings numeric limits', () => {
  const source = readFileSync(
    'packages/client/src/components/hermes/settings/AgentSettings.vue',
    'utf8',
  )

  it('does not impose a Studio-specific maximum-turns upper limit', () => {
    const maxTurnsInput = source.match(
      /<NInputNumber(?:(?!\/>)[\s\S])*?:value="settingsStore\.agent\.max_turns"(?:(?!\/>)[\s\S])*?\/>/,
    )?.[0]

    expect(maxTurnsInput).toBeDefined()
    expect(maxTurnsInput).not.toMatch(/:max=/)
    expect(maxTurnsInput).toContain(':min="1"')
  })

  it('allows zero to disable the gateway inactivity timeout', () => {
    const gatewayTimeoutInput = source.match(
      /<NInputNumber(?:(?!\/>)[\s\S])*?:value="settingsStore\.agent\.gateway_timeout"(?:(?!\/>)[\s\S])*?\/>/,
    )?.[0]

    expect(gatewayTimeoutInput).toBeDefined()
    expect(gatewayTimeoutInput).toContain(':min="0"')
  })
})
