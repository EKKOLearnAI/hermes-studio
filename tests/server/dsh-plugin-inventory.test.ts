import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativePluginEntries, readNativeDshPresetRoots, readNativeDshPluginInventory } from '../../packages/server/src/modules/coding-agents/services/dsh/plugin-inventory'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('reads the actual standard preset as 28 plugin entries, including nested groups and disabled providers', async () => {
  const content = await readFile('tests/fixtures/dsh-inventory/standard.cordis.yml', 'utf8')
  const entries = nativePluginEntries(content)
  expect(entries).toHaveLength(28)
  expect(entries.find(row => row.entryId === 'tool-bash')).toMatchObject({ configuredEnabled: 'conditional', runtimePhase: null })
  expect(entries.find(row => row.entryId === 'tool-subagent-codex')).toMatchObject({ configuredEnabled: false, groupPath: ['delegation'] })
  expect(entries.find(row => row.entryId === 'tool-web')).toMatchObject({ moduleName: '@deepseek-ai/dsh-tool-web', configuredEnabled: true })
  expect(entries.some(row => row.moduleName === 'cordis:group')).toBe(false)
})
it('discovers shipped and user roots with source, metadata, errors and first-root precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-inventory-')); roots.push(root)
  const pkg = join(root, 'package'), home = join(root, 'home')
  await mkdir(join(pkg, 'presets/standard'), { recursive: true })
  await mkdir(join(home, '.agent-presets/standard'), { recursive: true })
  await mkdir(join(home, '.agent-presets/custom'), { recursive: true })
  await mkdir(join(home, '.agent-presets/broken'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: '0.1.5-rc.2' }))
  await writeFile(join(pkg, 'presets/standard/agent.cordis.yml'), await readFile('tests/fixtures/dsh-inventory/standard.cordis.yml'))
  await writeFile(join(pkg, 'presets/standard/preset.yml'), 'name: Standard\norder: 1\n')
  await writeFile(join(home, '.agent-presets/standard/agent.cordis.yml'), '[]')
  await writeFile(join(home, '.agent-presets/custom/agent.cordis.yml'), '- name: example\n  disabled: !!js process.exit(99)\n')
  await writeFile(join(home, 'settings.yaml'), 'agent-presets:\n  default: custom\n')
  await symlink(pkg, join(home, '.agent-presets/escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await readNativeDshPresetRoots(join(pkg, 'package.json'), home)
  expect(result.runtimeConnected).toBe(false)
  expect(result.presets.map(p => p.id)).toEqual(['standard', 'broken', 'custom'])
  expect(result.presets[0]).toMatchObject({ name: 'Standard', trust: 'system' })
  expect(result.presets[0].entries).toHaveLength(28)
  expect(result.presets[1]).toMatchObject({ error: 'DSH_COMPOSITION_UNREADABLE' })
  expect(result.presets[2]).toMatchObject({ isDefault: true, trust: 'user', entries: [{ configuredEnabled: 'conditional' }] })
})
it('propagates group disabling and refuses malformed compositions without evaluating expressions', () => {
  expect(nativePluginEntries('- name: cordis:group\n  group: true\n  disabled: true\n  config:\n    - name: example\n      disabled: !!js throw new Error()\n')[0].configuredEnabled).toBe(false)
  expect(() => nativePluginEntries('- config: {}')).toThrow()
  expect(() => nativePluginEntries('- name: cordis:group\n  group: true\n  config: {}')).toThrow()
})
it.skipIf(!process.env.DSH_NATIVE_REAL_BIN)('reads installed DSH native presets using the actual CLI dependency graph', async () => {
  const inventory = await readNativeDshPluginInventory(resolve(process.env.DSH_NATIVE_REAL_BIN!), join(tmpdir(), 'dsh-native-read-only-fixture'))
  expect(inventory.presets.find(p => p.id === 'standard')?.entries).toHaveLength(28)
  expect(inventory.presets.map(p => p.id)).toEqual(expect.arrayContaining(['standard', 'minimal', 'ptc', 'cordis']))
})
