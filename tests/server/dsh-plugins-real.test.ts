import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { create } from 'tar'
import { expect, it } from 'vitest'
import { DshPluginStore } from '../../packages/server/src/modules/coding-agents/services/dsh/plugins'
import { prepareDshRuntime } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'
import { ProbeRpc } from '../fixtures/dsh-m0/rpc'

// Local registry + real published CLI. No user Home, paid model, or public publish.
it.skipIf(process.env.DSH_PLUGINS_REAL !== '1')('installs a real registry bundle and loads it into the native ACP process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-plugin-real-'))
  const store = new DshPluginStore(join(root, 'managed'))
  const bin = resolve(process.env.DSH_REAL_BIN || 'tests/fixtures/dsh-m0/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const calls: string[][] = []
  let commandError = ''
  const archiveDir = join(root, 'archive/package')
  await mkdir(archiveDir, { recursive: true })
  const manifest = { name: 'studio-local-probe', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'patch.yml' } }, scripts: { postinstall: 'node -e "process.exit(99)"' } }
  await writeFile(join(archiveDir, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(archiveDir, 'patch.yml'), '- insert:\n    - id: studio-managed-probe\n      name: ./plugin.mjs\n')
  await writeFile(join(archiveDir, 'plugin.mjs'), `
export const name = 'studio-managed-probe';
export function apply(ctx) {
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'studio/plugin-loaded',params:{version:'1.0.0'}})+'\\n');
}
`)
  const tgz = join(root, 'probe.tgz')
  await create({ cwd: join(root, 'archive'), file: tgz, gzip: true }, ['package'])
  const tarball = await readFile(tgz)
  const registry = createServer((req, res) => {
    if (req.url?.endsWith('.tgz')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(tarball); return }
    if (req.url !== '/studio-local-probe') { res.writeHead(404); res.end('{}'); return }
    const url = `http://127.0.0.1:${(registry.address() as any).port}/probe.tgz`
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...manifest, dist: { tarball: url, integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64') } } } }))
  })
  let child: ReturnType<typeof spawn> | undefined
  try {
    registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
    const execute = async (home: string, args: string[], signal: AbortSignal) => {
      calls.push(args)
      await promisify(execFile)(process.execPath, [bin, ...args], { cwd: home, signal, timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_registry: `http://127.0.0.1:${(registry.address() as any).port}` } }).catch(error => { commandError = String(error.stderr || error.stdout || error); throw error })
    }
    const install = await store.submit({ action: 'install', packageSpec: 'studio-local-probe@1.0.0', idempotencyKey: 'install' }, 'empty', execute)
    await expect.poll(async () => (await store.operation(install.id)).status, { timeout: 70_000 }).not.toBe('running')
    expect(await store.operation(install.id), commandError).toMatchObject({ status: 'succeeded' })
    expect((await store.snapshot()).packages[0]).toMatchObject({ version: '1.0.0', configuredEnabled: false })
    const toggle = await store.submit({ action: 'toggle', packageName: 'studio-local-probe', enabled: true, idempotencyKey: 'enable' }, (await store.snapshot()).revision, execute)
    await expect.poll(async () => (await store.operation(toggle.id)).status).toBe('succeeded')
    const prepared = await prepareDshRuntime({ sourceHome: join(root, 'native'), rootDir: join(root, 'runtime'), sharedSkills: join(root, 'skills'), systemPrompt: '', managedMcp: {}, managedPluginPatches: await store.runtimePatches(), model: 'test', baseUrl: 'http://127.0.0.1:1/v1' })
    child = spawn(process.execPath, [bin, ...prepared.args], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, DSH_HOME: join(root, 'runtime'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const rpc = new ProbeRpc(child)
    expect(await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1 })
    await expect.poll(() => rpc.notifications.find(event => event.method === 'studio/plugin-loaded')).toMatchObject({ params: { version: '1.0.0' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--ignore-scripts')
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'close') }
    await store.shutdown()
    await new Promise<void>(resolve => registry.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 100_000)
