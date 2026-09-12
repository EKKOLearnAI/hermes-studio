import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { readDshPluginMetadata } from '../../packages/server/src/modules/coding-agents/services/dsh/plugin-metadata'
it('reads published names and descriptions without executing the plugin entry point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-metadata-'))
  try {
    await mkdir(join(root, 'node_modules/example'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', displayName: 'Example Plugin', description: 'Checks metadata without loading code.', version: '1.2.3', main: 'fail.js' }))
    await writeFile(join(root, 'node_modules/example/fail.js'), 'throw new Error("must not execute")')
    expect(await readDshPluginMetadata('example/subpath', [join(root, 'package.json')])).toEqual({ title: 'Example Plugin', packageName: 'example', description: 'Checks metadata without loading code.', version: '1.2.3' })
    expect(await readDshPluginMetadata('./unpublished.mjs', [join(root, 'package.json')])).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
