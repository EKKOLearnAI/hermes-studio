import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refreshEntertainmentInternetAuthorization } from '../../packages/server/src/services/hermes/internet-execution'
import {
  ensureBuiltInAssistantRoles,
  getAssistantRole,
} from '../../packages/server/src/services/hermes/personal-twin'
import {
  clearLifeAssistantAuthorization,
  refreshLifeAssistantAuthorizations,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life orchestration security and compatibility closure', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-compatibility-'))
    process.env.HERMES_HOME = home
    ensureBuiltInAssistantRoles()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('changes only the shared entertainment role and preserves Internet authority when life authority clears', () => {
    const protectedRoles = ['commerce-assistant', 'fitness-coach', 'health-manager', 'home-manager']
    const before = protectedRoles.map(id => getAssistantRole(id))
    refreshEntertainmentInternetAuthorization('profile-main')
    refreshLifeAssistantAuthorizations([{ accountId: 'calendar-main', sourceKind: 'calendar', mode: 'shadow',
      currency: 'CNY', calendarIds: ['calendar-main'], subscriptionIds: [], planDigests: ['a'.repeat(64)] }])
    expect(protectedRoles.map(id => getAssistantRole(id))).toEqual(before)
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: expect.arrayContaining([
        'bilibili.video.inspect', 'bilibili.video.search', 'life.source.sync', 'life.calendar.hold.create',
      ]) },
      decisionAuthority: { allowedTargets: expect.arrayContaining([
        'internet:profile:profile-main', 'life:calendar:calendar-main', `life:plan:${'a'.repeat(64)}`,
      ]) },
    })
    clearLifeAssistantAuthorization()
    expect(protectedRoles.map(id => getAssistantRole(id))).toEqual(before)
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: { allow: ['bilibili.video.inspect', 'bilibili.video.search'] },
      decisionAuthority: { allowedTargets: expect.arrayContaining(['internet:profile:profile-main']) },
    })
  })

  it('keeps every closed-loop API mounted once and behind global authentication', () => {
    const source = readFileSync('packages/server/src/routes/index.ts', 'utf8')
    const authIndex = source.indexOf('authMiddleware.forEach')
    expect(authIndex).toBeGreaterThan(-1)
    for (const route of ['commerceRoutes', 'lifeOrchestrationRoutes', 'healthLoopRoutes', 'homeRoutes',
      'internetExecutionRoutes', 'androidCompanionRoutes']) {
      const mount = `app.use(${route}.routes())`
      expect(source.indexOf(mount), route).toBeGreaterThan(authIndex)
      expect(source.split(mount)).toHaveLength(2)
    }
  })
})
