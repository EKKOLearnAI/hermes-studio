import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hermes-group-agent-presets-'))
process.env.HERMES_WEB_UI_TEST_DB_DIR = join(root, 'db')
process.env.HERMES_WEB_UI_HOME = join(root, 'home')
process.env.HERMES_WEBUI_STATE_DIR = join(root, 'home')

const modelGroups = vi.hoisted(() => ({
  value: [{ provider: 'openai', models: ['gpt-test', 'gpt-new'] }],
}))
vi.mock('../../packages/server/src/controllers/hermes/models', () => ({
  getAvailableModelGroupsForProfile: vi.fn(async () => modelGroups.value),
}))

afterAll(async () => {
  const { closeDb } = await import('../../packages/server/src/db')
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('group Agent presets', () => {
  it('persists owner-scoped CRUD snapshots without secret fields', async () => {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    const {
      createGroupAgentPreset,
      deleteGroupAgentPreset,
      getGroupAgentPreset,
      listGroupAgentPresets,
      updateGroupAgentPreset,
    } = await import('../../packages/server/src/db/hermes/group-agent-preset-store')
    initAllStores()

    const created = createGroupAgentPreset({
      ownerUserId: 7,
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: 'Reviews pull requests',
      avatar: '',
    })

    expect(listGroupAgentPresets(7)).toEqual([created])
    expect(listGroupAgentPresets(8)).toEqual([])
    expect(getGroupAgentPreset(created.id, 8)).toBeNull()

    const updated = updateGroupAgentPreset(created.id, 7, {
      ...created,
      model: 'gpt-new',
      description: 'Updated definition',
    })
    expect(updated).toMatchObject({ model: 'gpt-new', description: 'Updated definition' })
    expect(deleteGroupAgentPreset(created.id, 8)).toBe(false)
    expect(deleteGroupAgentPreset(created.id, 7)).toBe(true)
  })

  it('rejects secrets and unavailable profile/provider/model references', async () => {
    const {
      normalizeGroupAgentPresetInput,
      validateGroupAgentPresetCapability,
    } = await import('../../packages/server/src/services/hermes/group-chat/agent-presets')

    expect(() => normalizeGroupAgentPresetInput({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      name: 'Reviewer',
      apiKey: 'secret',
    })).toThrow(/unsupported or secret fields/i)

    const preset = normalizeGroupAgentPresetInput({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: '',
      avatar: '',
    })
    expect(() => validateGroupAgentPresetCapability(preset, [
      { provider: 'openai', models: ['gpt-other'] },
    ])).toThrow(/unavailable/i)
    expect(() => validateGroupAgentPresetCapability(preset, [
      { provider: 'openai', models: ['gpt-test'] },
    ])).not.toThrow()
  })

  it('enforces owner/profile boundaries and fail-closes stale preset application', async () => {
    const controller = await import('../../packages/server/src/controllers/hermes/group-agent-presets')
    const createCtx: any = {
      state: { user: { id: 41, role: 'admin', profiles: ['research'] } },
      request: { body: {
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Reviewer API',
        description: '',
        avatar: '',
      } },
    }
    await controller.create(createCtx)
    expect(createCtx.status).toBe(201)
    const presetId = createCtx.body.preset.id

    const snapshot = await controller.resolveGroupAgentPresetForApplication(createCtx.state.user, presetId)
    expect(snapshot).toMatchObject({ name: 'Reviewer API', model: 'gpt-test' })
    await expect(controller.resolveGroupAgentPresetForApplication(
      { id: 42, role: 'admin', profiles: ['research'] },
      presetId,
    )).rejects.toMatchObject({ status: 404 })

    const deniedCtx: any = {
      state: { user: { id: 41, role: 'admin', profiles: ['default'] } },
      request: { body: createCtx.request.body },
    }
    await controller.create(deniedCtx)
    expect(deniedCtx.status).toBe(403)

    modelGroups.value = [{ provider: 'openai', models: ['gpt-new'] }]
    await expect(controller.resolveGroupAgentPresetForApplication(createCtx.state.user, presetId))
      .rejects.toMatchObject({ status: 409 })
    expect(snapshot).toMatchObject({ name: 'Reviewer API', model: 'gpt-test' })

    const listCtx: any = { state: createCtx.state, query: {} }
    await controller.list(listCtx)
    expect(listCtx.body.presets).toEqual([
      expect.objectContaining({ id: presetId, available: false, validationError: expect.stringContaining('unavailable') }),
    ])
  })
})
