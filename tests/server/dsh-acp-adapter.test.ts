import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeDshAcpAdapter } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-adapter'

it('rejects an unreviewed ACP artifact without modifying its installed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-adapter-version-'))
  try {
    const pkg = join(root, 'node_modules/@deepseek-ai/dsh-acp')
    await mkdir(join(pkg, 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: '0.1.5-rc.2' }))
    await writeFile(join(pkg, 'lib/index.js'), 'unreviewed source')
    await expect(writeDshAcpAdapter(join(root, 'package.json'), join(root, 'adapter.mjs'))).rejects.toMatchObject({ code: 'DSH_CAPABILITY_UNSUPPORTED' })
    expect(await readFile(join(pkg, 'lib/index.js'), 'utf8')).toBe('unreviewed source')
  } finally { await rm(root, { recursive: true, force: true }) }
})
