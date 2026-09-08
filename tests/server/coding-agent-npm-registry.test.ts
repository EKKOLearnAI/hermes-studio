import { describe, expect, it } from 'vitest'
import { withCodingAgentRegistry } from '../../packages/server/src/modules/coding-agents/services'

describe('coding Agent npm registry policy', () => {
  it.each([
    ['codex', '@openai/codex'],
    ['grok', '@xai-official/grok'],
  ] as const)('uses the official npm Registry for %s package operations', (agentId, packageName) => {
    expect(withCodingAgentRegistry(agentId, ['install', '-g', packageName])).toEqual([
      'install',
      '-g',
      packageName,
      '--registry=https://registry.npmjs.org',
    ])
    expect(withCodingAgentRegistry(agentId, ['view', packageName, 'version'])).toEqual([
      'view',
      packageName,
      'version',
      '--registry=https://registry.npmjs.org',
    ])
  })

  it.each(['claude-code', 'pi'] as const)(
    'keeps the configured npm Registry for %s',
    (agentId) => {
      expect(withCodingAgentRegistry(agentId, ['install', '-g', 'package'])).toEqual([
        'install',
        '-g',
        'package',
      ])
    },
  )
})
