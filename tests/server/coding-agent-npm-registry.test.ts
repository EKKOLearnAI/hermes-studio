import { describe, expect, it } from 'vitest'
import { withCodingAgentRegistry } from '../../packages/server/src/modules/coding-agents/services'

describe('coding Agent npm registry policy', () => {
  it('uses the official npm Registry for Grok package operations', () => {
    expect(withCodingAgentRegistry('grok', ['install', '-g', '@xai-official/grok'])).toEqual([
      'install',
      '-g',
      '@xai-official/grok',
      '--registry=https://registry.npmjs.org',
    ])
    expect(withCodingAgentRegistry('grok', ['view', '@xai-official/grok', 'version'])).toEqual([
      'view',
      '@xai-official/grok',
      'version',
      '--registry=https://registry.npmjs.org',
    ])
  })

  it.each(['claude-code', 'codex', 'pi'] as const)(
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
