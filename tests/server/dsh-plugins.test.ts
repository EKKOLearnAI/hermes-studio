import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativePluginArgs, changeNativeDshPlugins } from '../../packages/server/src/modules/coding-agents/services/dsh/plugins'
import { readDshWebPackages } from '../../packages/server/src/modules/coding-agents/services/dsh/plugin-inventory'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('targets the native Web profile and accepts pinned registry or GitHub packages', () => {
  expect(nativePluginArgs({ action: 'install', packageSpec: '@liustack/modlens@3.26.1' })).toEqual(['plugin', '--profile', 'web', 'add', '@liustack/modlens@3.26.1'])
  expect(nativePluginArgs({ action: 'install', packageSpec: 'github:liustack/modlens#a1923d0' }).at(-1)).toBe('github:liustack/modlens#a1923d0')
  for (const spec of ['--config=x', 'file:/tmp/plugin', 'example@latest', 'github:owner/repo#main', 'example@1.2.3;touch x']) expect(() => nativePluginArgs({ action: 'install', packageSpec: spec })).toThrow()
  expect(() => nativePluginArgs({ action: 'rollback', revisionId: 'old-acp' })).toThrow()
})
it('finds Web-installed packages separately from presets and rejects stale installation requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-packages-')); roots.push(root)
  const sourceHome = join(root, 'home'), command = join(root, 'dsh.js'), manifest = join(root, 'package.json')
  await writeFile(command, ''); await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh' }))
  await mkdir(join(sourceHome, 'profiles/web/node_modules/example'), { recursive: true })
  await writeFile(join(sourceHome, 'profiles/web/package.json'), JSON.stringify({ dependencies: { example: '1.2.3' }, dsh: { profile: { bundles: ['example'] } } }))
  await writeFile(join(sourceHome, 'profiles/web/node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.2.3', dsh: { client: {} } }))
  const inventory = await readDshWebPackages(manifest, sourceHome)
  expect(inventory.web.packages).toMatchObject([{ name: 'example', version: '1.2.3', bundle: true, containsBrowserPart: true }])
  const execute = vi.fn()
  await expect(changeNativeDshPlugins({ command, sourceHome, body: { action: 'remove', packageName: 'example' }, revision: 'stale', execute })).rejects.toMatchObject({ status: 412 })
  expect(execute).not.toHaveBeenCalled()
  await changeNativeDshPlugins({ command, sourceHome, body: { action: 'remove', packageName: 'example' }, revision: inventory.web.revision, execute })
  expect(execute).toHaveBeenCalledWith(sourceHome, ['plugin', '--profile', 'web', 'remove', 'example'], expect.any(AbortSignal))
})
