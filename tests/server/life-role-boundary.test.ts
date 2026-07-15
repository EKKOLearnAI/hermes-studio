import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureBuiltInAssistantRoles, getAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'

describe('life orchestration role boundary', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-role-'))
    process.env.HERMES_HOME = home
    ensureBuiltInAssistantRoles()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('keeps the entertainment assistant read-only and unbudgeted before runtime authorization', () => {
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      dataScope: { domains: ['entertainment', 'life', 'commerce'], includeProvenance: true },
      capabilityScope: { allow: ['twin.read'], deny: ['action.execute'], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'none', requireApprovalAbove: 'none', allowedTargets: [] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
  })
})

