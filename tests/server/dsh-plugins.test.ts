import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshPluginStore, parseDshPluginRequest, type DshPluginExecutor } from '../../packages/server/src/modules/coding-agents/services/dsh/plugins'
import { prepareDshRuntime } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'

let root: string, store: DshPluginStore
const profile = (home: string) => join(home, 'profiles/studio-acp')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const writeJson = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
const execute = vi.fn<DshPluginExecutor>(async (home, args) => {
  const path = profile(home), manifest = await json(join(path, 'package.json'))
  if (args[3] === 'add') {
    const spec = args[4], at = spec.lastIndexOf('@')
    manifest.dependencies[spec.slice(0, at)] = spec.slice(at + 1)
  } else if (args[3] === 'remove') delete manifest.dependencies[args[4]]
  manifest.dsh.profile.bundles = []
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const directory = join(path, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    const bundle = name !== 'dependency'
    await writeJson(join(directory, 'package.json'), { name, version, ...(bundle ? { dsh: { bundle: { patch: 'patch.yml' }, ...(name === 'browser' ? { client: { platform: 'web' } } : {}) } } : {}) })
    if (bundle) {
      await writeFile(join(directory, 'patch.yml'), '- id: root\n  insert:\n    - id: example\n      name: ./plugin.mjs\n      disabled: !!js process.env.NO_EVALUATION\n')
      manifest.dsh.profile.bundles.push(name)
    }
  }
  await writeJson(join(path, 'package.json'), manifest)
  await writeFile(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
})
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studio-plugin-test-')); store = new DshPluginStore(join(root, 'managed')); execute.mockClear() })
afterEach(async () => { await store.shutdown(); await rm(root, { recursive: true, force: true }) })
let key = 0
async function change(input: Record<string, unknown>, executor = execute) {
  const operation = await store.submit({ ...input, idempotencyKey: `test-${key++}` }, (await store.snapshot()).revision, executor)
  await vi.waitFor(async () => expect((await store.operation(operation.id)).status).not.toBe('running'))
  return store.operation(operation.id)
}

describe('DSH managed plugin revisions', () => {
  it('installs disabled bundles, distinguishes dependencies, preserves enabled order and immutable launches through update/remove/rollback', async () => {
    expect((await change({ action: 'install', packageSpec: '@demo/a@1.0.0' })).status).toBe('succeeded')
    expect((await store.snapshot()).packages[0]).toMatchObject({ name: '@demo/a', version: '1.0.0', kind: 'bundle', configuredEnabled: false, runtimePhase: null, compatibility: 'unverified', entries: [{ id: 'example', module: './plugin.mjs', configuredEnabled: 'conditional' }] })
    expect((await change({ action: 'install', packageSpec: 'dependency@2.0.0' })).status).toBe('succeeded')
    expect((await store.snapshot()).packages[1].kind).toBe('dependency')
    await change({ action: 'install', packageSpec: 'second@1.0.0' })
    await change({ action: 'toggle', packageName: 'second', enabled: true })
    await change({ action: 'toggle', packageName: '@demo/a', enabled: true })
    const before = await store.snapshot(), patches = await store.runtimePatches()
    expect(patches[0]).toContain('/second/patch.yml')
    expect(patches[1]).toContain('/@demo/a/patch.yml')
    await change({ action: 'update', packageSpec: '@demo/a@2.0.0' })
    expect((await store.snapshot()).packages[0]).toMatchObject({ version: '2.0.0', configuredEnabled: true })
    expect(await readFile(patches[0], 'utf8')).toContain('example')
    expect((await change({ action: 'remove', packageName: '@demo/a' })).status).toBe('succeeded')
    expect((await store.snapshot()).packages.map(p => p.name)).toEqual(['dependency', 'second'])
    expect(execute.mock.calls.at(-2)?.[1]).toEqual(['plugin', '--profile', 'studio-acp', 'install', '--frozen-lockfile', '--ignore-scripts'])
    await change({ action: 'rollback', revisionId: before.activeRevision })
    expect((await store.snapshot()).packages[0].version).toBe('1.0.0')
    expect(await store.runtimePatches()).toEqual(patches)
    expect((await store.snapshot()).revision).not.toBe(before.revision)
  })

  it('passes immutable managed patches before the enforced Studio overlay', async () => {
    await change({ action: 'install', packageSpec: 'example@1.0.0' })
    await change({ action: 'toggle', packageName: 'example', enabled: true })
    await change({ action: 'configure', content: '- id: example\n  disabled: false\n' })
    const patches = await store.runtimePatches()
    const prepared = await prepareDshRuntime({ sourceHome: join(root, 'native'), rootDir: join(root, 'runtime'), sharedSkills: join(root, 'skills'), systemPrompt: '', managedMcp: {}, managedPluginPatches: patches, model: 'test', baseUrl: 'http://localhost/v1' })
    expect(prepared.args).toEqual(['--profile', 'acp', ...patches.flatMap(path => ['--patch', path]), '--patch', join(root, 'runtime/studio.patch.yml')])
  })

  it('retains active state on executor failure and keeps private errors out of operations', async () => {
    await change({ action: 'configure', content: '[]\n' })
    const before = await store.snapshot()
    const operation = await change({ action: 'install', packageSpec: 'example@1.0.0' }, vi.fn(async () => { throw new Error('TOKEN=private-value') }))
    expect(operation).toMatchObject({ status: 'failed', code: 'DSH_PLUGIN_OPERATION_FAILED' })
    const after = await store.snapshot()
    expect(after.revision).toBe(before.revision)
    expect(after.activeRevision).toBe(before.activeRevision)
    expect(JSON.stringify(after)).not.toContain('private-value')
  })

  it('requires revisions, deduplicates retries, and rejects competing operations without running twice', async () => {
    const input = { action: 'install', packageSpec: 'example@1.0.0', idempotencyKey: 'retry' }
    await expect(store.submit(input, undefined, execute)).rejects.toMatchObject({ status: 428 })
    await expect(store.submit(input, 'stale', execute)).rejects.toMatchObject({ status: 412 })
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const slow = vi.fn<DshPluginExecutor>(async (...args) => { await gate; await execute(...args) })
    const first = await store.submit(input, 'empty', slow)
    expect((await store.submit(input, 'empty', slow)).id).toBe(first.id)
    await expect(store.submit({ ...input, packageSpec: 'example@2.0.0' }, 'empty', slow)).rejects.toMatchObject({ status: 409 })
    await expect(new DshPluginStore(store.root).submit({ ...input, idempotencyKey: 'other' }, 'empty', execute)).rejects.toMatchObject({ status: 409 })
    resume()
    await vi.waitFor(async () => expect((await store.operation(first.id)).status).toBe('succeeded'))
    expect(slow).toHaveBeenCalledTimes(1)
    expect((await store.submit(input, 'empty', slow)).id).toBe(first.id)
    await expect(store.submit({ action: 'configure', content: '[]', idempotencyKey: 'fresh' }, 'empty', execute)).rejects.toMatchObject({ status: 412 })
  })

  it('interrupts owned work on shutdown and reconciles abandoned operation journals', async () => {
    const waiting = vi.fn<DshPluginExecutor>(async (_home, _args, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const op = await store.submit({ action: 'install', packageSpec: 'example@1.0.0', idempotencyKey: 'shutdown' }, 'empty', waiting)
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled())
    await store.shutdown()
    expect(await store.operation(op.id)).toMatchObject({ status: 'failed', code: 'DSH_OPERATION_INTERRUPTED' })
    await expect(store.submit({ action: 'configure', content: '[]', idempotencyKey: 'late' }, 'empty', execute)).rejects.toMatchObject({ status: 503 })
    const statePath = join(store.root, 'state.json'), state = await json(statePath)
    state.operations[0].status = 'running'
    await writeJson(statePath, state)
    const restarted = new DshPluginStore(store.root)
    expect((await restarted.snapshot()).operations[0]).toMatchObject({ status: 'failed', code: 'DSH_OPERATION_INTERRUPTED' })
  })

  it('blocks browser activation, non-bundle activation, and escaping package paths', async () => {
    await change({ action: 'install', packageSpec: 'browser@1.0.0' })
    expect(await change({ action: 'toggle', packageName: 'browser', enabled: true })).toMatchObject({ status: 'failed', code: 'DSH_CAPABILITY_UNSUPPORTED' })
    await change({ action: 'install', packageSpec: 'dependency@1.0.0' })
    expect(await change({ action: 'toggle', packageName: 'dependency', enabled: true })).toMatchObject({ status: 'failed' })
    const before = await store.snapshot()
    const malicious = vi.fn<DshPluginExecutor>(async (home, args, signal) => {
      await execute(home, args, signal)
      const directory = join(profile(home), 'node_modules/escape')
      await rm(directory, { recursive: true, force: true })
      await symlink(root, directory, process.platform === 'win32' ? 'junction' : 'dir')
    })
    expect(await change({ action: 'install', packageSpec: 'escape@1.0.0' }, malicious)).toMatchObject({ status: 'failed', code: 'DSH_CAPABILITY_UNSUPPORTED' })
    expect((await store.snapshot()).activeRevision).toBe(before.activeRevision)
  })

  it.each(['foo', 'foo@latest', 'foo@^1.0.0', 'git+https://example.com/a', '../foo@1.0.0', '--help@1.0.0', '@scope/pkg@file:abc'])('rejects non-exact or non-registry spec %s', packageSpec => {
    expect(() => parseDshPluginRequest({ action: 'install', packageSpec, idempotencyKey: 'test' })).toThrow()
  })
  it('validates YAML structure without evaluating expressions and rejects oversized drafts', () => {
    const content = '- id: example\n  config: !!js process.exit(99)\n'
    expect(parseDshPluginRequest({ action: 'configure', content, idempotencyKey: 'test' })).toMatchObject({ content })
    for (const content of ['object: true', '[', ' '.repeat(256 * 1024 + 1)]) expect(() => parseDshPluginRequest({ action: 'configure', content, idempotencyKey: 'test' })).toThrow()
  })
})
