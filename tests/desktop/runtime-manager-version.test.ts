import { describe, expect, it } from 'vitest'
import {
  hermesAgentVersionFromRuntimeTag,
  runtimeManifestMatchesHermesAgentVersion,
} from '../../packages/desktop/src/main/runtime-version'

describe('desktop runtime version checks', () => {
  it('derives the Hermes Agent version from the runtime release tag', () => {
    expect(hermesAgentVersionFromRuntimeTag('hermes-0.15.2-runtime')).toBe('0.15.2')
    expect(hermesAgentVersionFromRuntimeTag('latest')).toBeNull()
  })

  it('compares cached runtime manifests to the expected Hermes Agent version', () => {
    expect(runtimeManifestMatchesHermesAgentVersion({ hermesAgentVersion: '0.15.2' }, '0.15.2')).toBe(true)
    expect(runtimeManifestMatchesHermesAgentVersion({ hermesAgentVersion: '0.15.1' }, '0.15.2')).toBe(false)
    expect(runtimeManifestMatchesHermesAgentVersion({ asset: { name: 'hermes-runtime-hermes-agent-0.15.2-win-x64.tar.gz' } }, '0.15.2')).toBe(true)
    expect(runtimeManifestMatchesHermesAgentVersion({}, '0.15.2')).toBeNull()
  })
})
