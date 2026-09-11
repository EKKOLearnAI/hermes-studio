import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, expect, it, vi } from 'vitest'

const execution = vi.hoisted(() => {
  const run = vi.fn()
  const execFile = vi.fn()
  ;(execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = run
  return { execFile, run }
})
vi.mock('child_process', () => ({ execFile: execution.execFile }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', async (original) => ({
  ...await original<typeof import('../../packages/server/src/modules/studio/public/profile-config')>(),
  safeReadFile: async (path: string) => { try { return readFileSync(path, 'utf-8') } catch { return null } },
  getProfileDir: (profile: string) => join(process.env.HERMES_WEB_UI_HOME!, 'profiles', profile),
  readConfigYamlForProfile: async () => ({}),
  getActiveProfileName: () => 'default',
}))

const homes: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  execution.run.mockReset()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

it.each([
  ['install', true], ['install', false], ['launch', true], ['launch', false],
] as const)('%s installs the bundled adapter only when the user has none (user adapter: %s)', async (action, hasUserAdapter) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-install-'))
  homes.push(home)
  vi.stubEnv('HERMES_WEB_UI_HOME', home)
  vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', join(home, 'global-home'))
  const settingsPath = join(home, 'global-home', '.pi', 'agent', 'settings.json')
  mkdirSync(dirname(settingsPath), { recursive: true })
  const settings = JSON.stringify({ packages: hasUserAdapter ? ['npm:pi-mcp-adapter@2.32.1'] : [] })
  writeFileSync(settingsPath, settings)
  execution.run.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--prefix')) {
      const adapterRoot = args[args.indexOf('--prefix') + 1]
      const adapter = join(adapterRoot, 'node_modules', 'pi-mcp-adapter', 'index.ts')
      mkdirSync(dirname(adapter), { recursive: true })
      writeFileSync(adapter, 'export default function () {}')
    }
    return { stdout: args.includes('--version') ? '1.0.0' : '', stderr: '' }
  })
  const { installCodingAgent, prepareCodingAgentLaunch } = await import('../../packages/server/src/bootstrap/coding-agents')
  if (action === 'install') {
    const result = await installCodingAgent('pi')
    expect(result.success).toBe(true)
  } else {
    await Promise.all([
      prepareCodingAgentLaunch('pi', { profile: 'default', provider: 'test', model: 'test-model' }),
      prepareCodingAgentLaunch('pi', { profile: 'default', provider: 'test', model: 'test-model' }),
    ])
    // A later launch should reuse the installed bundle rather than reinstall it.
    await prepareCodingAgentLaunch('pi', { profile: 'default', provider: 'test', model: 'test-model' })
  }
  const installs = execution.run.mock.calls.filter(([, args]) => args.includes('install'))
  expect(installs.some(([, args]) => args.includes('@earendil-works/pi-coding-agent'))).toBe(action === 'install')
  expect(installs.filter(([, args]) => args.includes('pi-mcp-adapter'))).toHaveLength(hasUserAdapter ? 0 : 1)
  expect(readFileSync(settingsPath, 'utf-8')).toBe(settings)
})
