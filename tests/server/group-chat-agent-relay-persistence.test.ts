import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('group Agent outbound Relay persistence', () => {
  let stateDir = ''
  let originalWebUiHome: string | undefined
  let originalStateDir: string | undefined

  beforeEach(() => {
    originalWebUiHome = process.env.HERMES_WEB_UI_HOME
    originalStateDir = process.env.HERMES_WEBUI_STATE_DIR
    stateDir = mkdtempSync(join(tmpdir(), 'group-agent-relay-persistence-'))
    process.env.HERMES_WEB_UI_HOME = stateDir
    process.env.HERMES_WEBUI_STATE_DIR = stateDir
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    rmSync(stateDir, { recursive: true, force: true })
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (originalStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
    else process.env.HERMES_WEBUI_STATE_DIR = originalStateDir
  })

  it('stores links inside the group-chat state directory', async () => {
    const legacyLinksFile = join(stateDir, 'group-chat-agent-links.json')
    writeFileSync(legacyLinksFile, `${JSON.stringify([{
      cloudOrigin: 'https://legacy.example',
      targetOrigin: 'http://127.0.0.1:8648',
      connectorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      credential: 'l'.repeat(48),
      agent: {
        agent: 'hermes',
        profile: 'legacy',
        name: 'Legacy Agent',
      },
    }], null, 2)}\n`)
    const { GroupAgentOutboundRelayManager } = await import(
      '../../packages/server/src/services/hermes/group-chat/agent-relay'
    )
    const manager = new GroupAgentOutboundRelayManager(() => null)

    await manager.persist({
      cloudOrigin: 'https://cloud.example',
      targetOrigin: 'http://127.0.0.1:8648',
      connectorId: '11111111-2222-4333-8444-555555555555',
      credential: 'c'.repeat(48),
      agent: {
        agent: 'hermes',
        profile: 'default',
        name: 'Remote Agent',
      },
    })

    const linksFile = join(stateDir, 'group-chat', 'group-chat-agent-links.json')
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toHaveLength(1)
    expect(existsSync(legacyLinksFile)).toBe(true)
    expect(JSON.parse(readFileSync(legacyLinksFile, 'utf8'))).toHaveLength(1)
    manager.shutdown()
  })
})
