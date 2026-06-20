import { existsSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const agentBridgeMocks = vi.hoisted(() => ({
  destroyAll: vi.fn(),
  destroyProfile: vi.fn(),
}))

const skillInjectorMocks = vi.hoisted(() => ({
  injectMissingSkills: vi.fn(),
  resolveTargetDirForProfile: vi.fn(),
}))

const sessionDeleterMocks = vi.hoisted(() => ({
  switchProfile: vi.fn(),
}))

const gatewayAutostartMocks = vi.hoisted(() => ({
  getGatewayRuntimeStatusForProfile: vi.fn(),
  prepareGatewayForProfileDelete: vi.fn(),
  restartGatewayForProfile: vi.fn(),
}))

// Mock hermes-cli
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => ({
    destroyAll: agentBridgeMocks.destroyAll,
    destroyProfile: agentBridgeMocks.destroyProfile,
  })),
}))

vi.mock('../../packages/server/src/services/hermes/skill-injector', () => {
  const HermesSkillInjector = vi.fn(() => ({
    injectMissingSkills: skillInjectorMocks.injectMissingSkills,
  })) as any
  HermesSkillInjector.resolveTargetDirForProfile = skillInjectorMocks.resolveTargetDirForProfile
  return { HermesSkillInjector }
})

vi.mock('../../packages/server/src/services/hermes/session-deleter', () => ({
  SessionDeleter: {
    getInstance: vi.fn(() => sessionDeleterMocks),
  },
}))

vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => ({
  getGatewayRuntimeStatusForProfile: gatewayAutostartMocks.getGatewayRuntimeStatusForProfile,
  prepareGatewayForProfileDelete: gatewayAutostartMocks.prepareGatewayForProfileDelete,
  restartGatewayForProfile: gatewayAutostartMocks.restartGatewayForProfile,
}))

import * as hermesCli from '../../packages/server/src/services/hermes/hermes-cli'

describe('Profile Routes', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
  const tempHomes: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 0 })
    gatewayAutostartMocks.prepareGatewayForProfileDelete.mockResolvedValue(undefined)
    skillInjectorMocks.injectMissingSkills.mockResolvedValue({ targets: [] })
    skillInjectorMocks.resolveTargetDirForProfile.mockImplementation((name: string) => join('/tmp/hermes-skills', name))
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  describe('hermes-cli wrapper', () => {
    it('listProfiles returns array', async () => {
      const mockProfiles = [{ name: 'default', active: true }]
      vi.mocked(hermesCli.listProfiles).mockResolvedValue(mockProfiles as any)

      const result = await hermesCli.listProfiles()
      expect(result).toEqual(mockProfiles)
    })

    it('getProfile returns profile detail', async () => {
      const mockDetail = { name: 'default', path: '/tmp/default' }
      vi.mocked(hermesCli.getProfile).mockResolvedValue(mockDetail as any)

      const result = await hermesCli.getProfile('default')
      expect(result).toEqual(mockDetail)
      expect(hermesCli.getProfile).toHaveBeenCalledWith('default')
    })

    it('createProfile calls CLI with name and clone flag', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      await hermesCli.createProfile('test', true)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('test', true)
    })

    it('clone creation copies only the configured model provider auth for the new profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-auth-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
        providers: {
          'openai-codex': { access_token: 'codex-provider-token' },
          anthropic: { access_token: 'anthropic-provider-token' },
        },
        credential_pool: {
          'openai-codex': [{ access_token: 'codex-pool-token' }],
          anthropic: [{ access_token: 'anthropic-pool-token' }],
        },
      }, null, 2), 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        const profileDir = join(hermesHome, 'profiles', name)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(profileDir, 'config.yaml'), [
          'model:',
          '  provider: openai-codex',
          '  default: gpt-5.5',
          '',
        ].join('\n'), 'utf-8')
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', clone: true } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.copiedAuthProviders).toEqual(['openai-codex'])
      const clonedAuth = JSON.parse(readFileSync(join(hermesHome, 'profiles', 'cloned', 'auth.json'), 'utf-8'))
      expect(clonedAuth.providers['openai-codex']).toEqual({ access_token: 'codex-provider-token' })
      expect(clonedAuth.credential_pool['openai-codex']).toEqual([{ access_token: 'codex-pool-token' }])
      expect(clonedAuth.providers.anthropic).toBeUndefined()
      expect(clonedAuth.credential_pool.anthropic).toBeUndefined()
    })

    it('deleteProfile calls CLI with name', async () => {
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)

      await hermesCli.deleteProfile('test')

      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('test')
    })

    it('renameProfile calls CLI with old and new name', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)

      await hermesCli.renameProfile('old', 'new')

      expect(hermesCli.renameProfile).toHaveBeenCalledWith('old', 'new')
    })
  })

  describe('profile rename validation', () => {
    it('rejects reserved profile names before calling Hermes CLI', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)
      const { rename } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { new_name: 'hermes' } },
        status: 200,
        body: undefined,
      }

      await rename(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: "Profile name 'hermes' is reserved and cannot be used" })
      expect(hermesCli.renameProfile).not.toHaveBeenCalled()
    })
  })

  describe('profile deletion fallback', () => {
    it('prepares the profile gateway for deletion before calling Hermes CLI delete', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')

      gatewayAutostartMocks.prepareGatewayForProfileDelete.mockImplementation(async () => {
        await rm(profileDir, { recursive: true, force: true })
      })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(gatewayAutostartMocks.prepareGatewayForProfileDelete).toHaveBeenCalledWith('work')
      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('work')
      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
    })

    it('does not return success when Hermes CLI reports delete success but the profile directory remains', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile: profile directory still exists' })
      expect(existsSync(profileDir)).toBe(true)
    })

    it('removes a reserved profile directory when Hermes CLI refuses to delete it', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const badProfileDir = join(hermesHome, 'profiles', 'hermes')
      await mkdir(badProfileDir, { recursive: true })
      await writeFile(join(badProfileDir, 'config.yaml'), 'model:\n  default: bad\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'hermes\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'hermes' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true, fallback: 'removed_reserved_profile_from_disk' })
      expect(existsSync(badProfileDir)).toBe(false)
      expect(readFileSync(join(hermesHome, 'active_profile'), 'utf-8')).toBe('default\n')
    })

    it('does not bypass Hermes CLI failures for normal profile names', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile' })
      expect(existsSync(profileDir)).toBe(true)
    })
  })

  describe('Hermes CLI active profile switch', () => {
    it('only destroys bridge sessions for the target profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-switch-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: gpt-test\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'work\n', 'utf-8')
      vi.mocked(hermesCli.useProfile).mockResolvedValue('Switched to work')
      vi.mocked(hermesCli.getProfile).mockResolvedValue({
        name: 'work',
        path: profileDir,
        model: 'gpt-test',
        provider: 'test',
        skills: 0,
        hasEnv: false,
        hasSoulMd: false,
      } as any)
      agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 2 })
      const { switchProfile } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        request: { body: { name: 'work' } },
        status: 200,
        body: undefined,
      }

      await switchProfile(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ success: true, active: 'work' })
      expect(agentBridgeMocks.destroyProfile).toHaveBeenCalledWith('work')
      expect(agentBridgeMocks.destroyAll).not.toHaveBeenCalled()
      expect(sessionDeleterMocks.switchProfile).toHaveBeenCalledWith('work')
    })
  })

  describe('profile avatars', () => {
    it('stores generated avatar metadata under the Web UI home', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const { updateAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'generated', seed: 'custom-seed' } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const metaPath = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'), 'avatar.json')
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'generated', seed: 'custom-seed' })
      expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({
        type: 'generated',
        seed: 'custom-seed',
      })
    })

    it('stores uploaded image avatars and returns a data URL', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const dataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`
      const { updateAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'image', dataUrl } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const dir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      const meta = JSON.parse(readFileSync(join(dir, 'avatar.json'), 'utf-8'))
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'image', dataUrl })
      expect(meta).toMatchObject({ type: 'image', file: 'avatar.bin', mime: 'image/png' })
      expect(readFileSync(join(dir, 'avatar.bin')).toString()).toBe('avatar-png')
    })

    it('deletes profile avatar metadata', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      await writeFile(join(metadataDir, 'avatar.json'), '{"type":"generated"}\n', 'utf-8')
      const { deleteAvatar } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await deleteAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(existsSync(metadataDir)).toBe(false)
    })
  })
})
