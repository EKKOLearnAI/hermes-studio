import { describe, expect, it } from 'vitest'
import {
  classifyServerFile,
  collectModuleSpecifiers,
  forbiddenDomainDependency,
  legacyAppAliasFailure,
  studioOwnershipFailure,
  validateTargetDependency,
} from '../../scripts/server-module-boundaries.mjs'

describe('server module boundary harness', () => {
  it('recognizes only the planned module roots', () => {
    expect(classifyServerFile('modules/hermes/services/kanban/service.ts')).toMatchObject({
      architecture: 'target',
      domain: 'hermes',
      layer: 'services',
      validModule: true,
    })
    expect(classifyServerFile('modules/other/services/example.ts')).toMatchObject({
      architecture: 'target',
      domain: 'other',
      validModule: false,
    })
    expect(classifyServerFile('index.ts')).toMatchObject({
      architecture: 'target',
      domain: 'bootstrap',
    })
    expect(classifyServerFile('services/legacy.ts')).toMatchObject({
      architecture: 'legacy',
      domain: 'unassigned',
    })
  })

  it('enforces the acyclic domain dependency matrix', () => {
    expect(forbiddenDomainDependency('studio', 'hermes')).toBe(true)
    expect(forbiddenDomainDependency('hermes', 'ekko')).toBe(true)
    expect(forbiddenDomainDependency('coding-agents', 'hermes')).toBe(true)
    expect(forbiddenDomainDependency('hermes', 'studio')).toBe(false)
    expect(forbiddenDomainDependency('bootstrap', 'ekko')).toBe(false)
  })

  it('allows agents to consume only Studio contracts and public APIs', () => {
    expect(validateTargetDependency(
      'modules/ekko/services/run.ts',
      'modules/studio/contracts/agents/runner.ts',
    )).toEqual([])
    expect(validateTargetDependency(
      'modules/ekko/services/run.ts',
      'modules/studio/services/config/service.ts',
    )).toEqual([
      'modules/ekko/services/run.ts must use Studio contracts/public APIs, not Studio internal path modules/studio/services/config/service.ts',
    ])
  })

  it('keeps routes out of services and agent modules apart', () => {
    expect(validateTargetDependency(
      'modules/hermes/routes/kanban.ts',
      'modules/hermes/services/kanban/service.ts',
    )[0]).toContain('must delegate through controllers')
    expect(validateTargetDependency(
      'modules/hermes/controllers/chat.ts',
      'modules/coding-agents/public/runner.ts',
    )[0]).toContain('must not depend')
  })

  it('keeps file, download, preview, and upload capabilities in Studio', () => {
    expect(studioOwnershipFailure('modules/hermes/routes/files.ts')).toContain(
      'Studio-owned file capability under Hermes',
    )
    expect(studioOwnershipFailure('modules/hermes/controllers/app-upload.ts')).toContain(
      'Studio-owned file capability under Hermes',
    )
    expect(studioOwnershipFailure('modules/hermes/services/files/file-provider.ts')).toContain(
      'Studio-owned file capability under Hermes',
    )
    expect(studioOwnershipFailure('modules/studio/routes/files.ts')).toBeNull()
    expect(studioOwnershipFailure('modules/hermes/services/profiles/app-profile-avatar.ts')).toBeNull()
  })

  it('keeps released-client aliases in the single Studio compatibility middleware', () => {
    expect(legacyAppAliasFailure(
      'modules/studio/routes/sessions.ts',
      "routes.get('/api/hermes/sessions', controller)",
    )).toContain('keep released-client aliases in modules/studio/middleware/legacy-app-api.ts')
    expect(legacyAppAliasFailure(
      'modules/studio/middleware/legacy-app-api.ts',
      "['/api/hermes/sessions', '/api/studio/sessions']",
    )).toBeNull()
    expect(legacyAppAliasFailure(
      'modules/hermes/routes/jobs.ts',
      "routes.get('/api/hermes/jobs', controller)",
    )).toBeNull()
    expect(legacyAppAliasFailure(
      'modules/studio/routes/mcu-firmware.ts',
      "routes.get('/api/hermes/mcu/firmware.bin', controller)",
    )).toContain('keep released-client aliases in modules/studio/middleware/legacy-app-api.ts')
  })

  it('keeps controllers and services pointed down the layer graph', () => {
    expect(validateTargetDependency(
      'modules/studio/controllers/group-chat.ts',
      'modules/studio/controllers/group-chat-invite.ts',
    )).toEqual([])
    expect(validateTargetDependency(
      'modules/studio/controllers/update.ts',
      'modules/studio/repositories/settings/version.ts',
    )[0]).toContain('must delegate through services')
    expect(validateTargetDependency(
      'modules/studio/services/update/studio-updater.ts',
      'modules/studio/controllers/update.ts',
    )[0]).toContain('must not depend on transport layer')
  })

  it('does not let migrated modules reach back into legacy source', () => {
    expect(validateTargetDependency(
      'modules/hermes/services/profile/service.ts',
      'services/hermes/hermes-profile.ts',
    )).toEqual([
      'modules/hermes/services/profile/service.ts must not import legacy server source services/hermes/hermes-profile.ts',
    ])
  })

  it('parses static, exported, dynamic, and require dependencies', () => {
    const source = [
      "import value from './a'",
      "export type { Value } from './b'",
      "const lazy = import('./c')",
      "const legacy = require('./d')",
    ].join('\n')
    expect(collectModuleSpecifiers(source)).toEqual(['./a', './b', './c', './d'])
  })

})
