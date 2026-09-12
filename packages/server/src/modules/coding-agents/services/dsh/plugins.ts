import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { getWebUiHome } from '../../../studio/public/config'

const PROFILE = 'studio-acp'
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const ID = /^[a-zA-Z0-9_-]{1,100}$/

export class DshPluginError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
function fail(status: number, code: string, message: string): never { throw new DshPluginError(status, code, message) }
type Change = { action: 'install' | 'update'; packageSpec: string }
  | { action: 'remove'; packageName: string }
  | { action: 'toggle'; packageName: string; enabled: boolean }
  | { action: 'configure'; content: string }
  | { action: 'rollback'; revisionId: string }
export type DshPluginRequest = Change & { idempotencyKey: string }
export interface DshPluginOperation {
  id: string; action: Change['action']; status: 'running' | 'succeeded' | 'failed'
  createdAt: string; finishedAt?: string; revision?: string; code?: string
  packageName?: string
}
interface StoredOperation extends DshPluginOperation { key: string; fingerprint: string }
interface Revision { id: string; createdAt: string; dependencyRevision: string }
interface State { revision: string; active: string | null; revisions: Revision[]; operations: StoredOperation[] }
export type DshPluginExecutor = (home: string, args: string[], signal: AbortSignal) => Promise<void>

export function parseDshPluginRequest(input: unknown): DshPluginRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'DSH_SELECTION_INVALID', 'Expected an operation')
  const row = input as Record<string, unknown>
  const key = row.idempotencyKey
  if (typeof key !== 'string' || !ID.test(key)) fail(400, 'DSH_SELECTION_INVALID', 'A valid idempotency key is required')
  const name = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 214 || !NAME.test(value)) fail(400, 'DSH_SELECTION_INVALID', 'Invalid registry package name')
    return value
  }
  if (row.action === 'install' || row.action === 'update') {
    if (typeof row.packageSpec !== 'string') fail(400, 'DSH_SELECTION_INVALID', 'Use package@exact-version')
    const split = row.packageSpec.lastIndexOf('@')
    name(row.packageSpec.slice(0, split))
    if (split < 1 || !VERSION.test(row.packageSpec.slice(split + 1))) fail(400, 'DSH_SELECTION_INVALID', 'Use package@exact-version')
    return { action: row.action, packageSpec: row.packageSpec, idempotencyKey: key }
  }
  if (row.action === 'remove') return { action: row.action, packageName: name(row.packageName), idempotencyKey: key }
  if (row.action === 'toggle' && typeof row.enabled === 'boolean') return { action: row.action, packageName: name(row.packageName), enabled: row.enabled, idempotencyKey: key }
  if (row.action === 'configure' && typeof row.content === 'string') {
    validatePatch(row.content)
    return { action: row.action, content: row.content, idempotencyKey: key }
  }
  if (row.action === 'rollback' && typeof row.revisionId === 'string' && ID.test(row.revisionId)) return { action: row.action, revisionId: row.revisionId, idempotencyKey: key }
  return fail(400, 'DSH_SELECTION_INVALID', 'Invalid plugin operation')
}

function validatePatch(content: string) {
  if (Buffer.byteLength(content) > 256 * 1024) fail(400, 'DSH_SELECTION_INVALID', 'Plugin configuration exceeds 256 KiB')
  const doc = parseDocument(content.trim() || '[]', { logLevel: 'silent' })
  if (doc.errors.length || !isSeq(doc.contents)) fail(400, 'DSH_SELECTION_INVALID', 'Plugin configuration must be a YAML patch sequence')
  return doc
}
async function readOptional(path: string, fallback: string) {
  try { return await readFile(path, 'utf8') } catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error }
}
async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}
function contained(parent: string, child: string) { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
function publicOperation({ key: _key, fingerprint: _fingerprint, ...operation }: StoredOperation): DshPluginOperation { return operation }

/** A supplemental ACP source owned by Studio; user Homes are never package-operation targets. */
export class DshPluginStore {
  private closing = false
  private pending = new Map<string, { abort: AbortController; done: Promise<void> }>()
  constructor(readonly root: string) {}
  private profile(id: string) { return join(this.root, 'revisions', id, 'profiles', PROFILE) }
  private async state(): Promise<State> {
    return JSON.parse(await readOptional(join(this.root, 'state.json'), JSON.stringify({ revision: 'empty', active: null, revisions: [], operations: [] })))
  }
  private async save(state: State) { await atomicJson(join(this.root, 'state.json'), state) }
  private async lock(): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, 'operation.lock')
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify({ pid: process.pid })); await file.close()
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      // Only reclaim a recorded dead owner. Unreadable/in-progress locks stay busy.
      try {
        const { pid } = JSON.parse(await readFile(path, 'utf8'))
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock owner')
        try { process.kill(pid, 0) } catch (error: any) {
          if (error.code === 'ESRCH') {
            // Serialize stale-owner reclamation so two servers cannot unlink a
            // replacement lock acquired between their liveness checks.
            const reclaim = await open(`${path}.reclaim`, 'wx', 0o600)
            try {
              const current = JSON.parse(await readFile(path, 'utf8'))
              if (current.pid === pid) await rm(path)
            } finally { await reclaim.close(); await rm(`${path}.reclaim`, { force: true }) }
            return this.lock()
          }
          throw error
        }
      } catch {}
      fail(409, 'DSH_OPERATION_CONFLICT', 'Another plugin operation is running')
    }
    return async () => { await rm(path, { force: true }) }
  }
  private async recover(state: State) {
    for (const operation of state.operations) if (operation.status === 'running') {
      operation.status = 'failed'; operation.code = 'DSH_OPERATION_INTERRUPTED'; operation.finishedAt = new Date().toISOString()
    }
    await this.save(state)
  }
  private async manifest(id: string) { return JSON.parse(await readFile(join(this.profile(id), 'package.json'), 'utf8')) }
  private async inventory(id: string) {
    const manifest = await this.manifest(id)
    const packages = []
    for (const name of Object.keys(manifest.dependencies || {})) {
      if (!NAME.test(name)) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Invalid dependency metadata')
      const directory = await realpath(join(this.profile(id), 'node_modules', name))
      if (!contained(await realpath(join(this.root, 'revisions')), directory)) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Dependency points outside managed snapshots')
      const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (installed.name !== name || !VERSION.test(installed.version) || installed.version !== manifest.dependencies[name]) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Installed package does not match the exact dependency')
      const declaration = installed.dsh?.bundle?.patch
      let patchPath: string | null = null
      let entries: Array<{ id: string; module: string; configuredEnabled: boolean | 'conditional' }> = []
      if (declaration !== undefined) {
        if (typeof declaration !== 'string' || isAbsolute(declaration)) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Unsupported bundle patch path')
        patchPath = await realpath(join(directory, declaration))
        if (!contained(directory, patchPath)) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Bundle patch escapes its package')
        const doc = validatePatch(await readFile(patchPath, 'utf8'))
        const scan = (sequence: unknown) => {
          if (!isSeq(sequence)) return
          for (const row of sequence.items) if (isMap(row)) {
            const module = row.get('name'); const entryId = row.get('id'); const disabled = row.get('disabled', true)
            if (typeof module === 'string' && typeof entryId === 'string') entries.push({ id: entryId, module,
              configuredEnabled: disabled === undefined ? true : isScalar(disabled) && !disabled.tag && typeof disabled.value === 'boolean' ? !disabled.value : 'conditional' })
            scan(row.get('insert', true)); if (row.get('group') === true) scan(row.get('config', true))
          }
        }
        scan(doc.contents)
      }
      packages.push({ name, version: String(installed.version || ''), kind: patchPath ? 'bundle' : 'dependency',
        configuredEnabled: (manifest.dsh?.profile?.bundles || []).includes(name),
        containsBrowserPart: installed.dsh?.client?.platform === 'web', compatibility: 'unverified', runtimePhase: null,
        entries, patchPath })
    }
    return packages
  }
  async snapshot() {
    // A restart can observe a running operation left by a dead server. Reconcile
    // its journal without re-executing package commands or changing active state.
    let state = await this.state()
    if (state.operations.some(operation => operation.status === 'running') && !this.pending.size) {
      try { const release = await this.lock(); try { state = await this.state(); await this.recover(state) } finally { await release() } }
      catch (error) { if (!(error instanceof DshPluginError && error.status === 409)) throw error }
    }
    const packages = state.active ? await this.inventory(state.active) : []
    return { sourceId: 'studio-acp', revision: state.revision, activeRevision: state.active,
      packages: packages.map(({ patchPath: _path, ...item }) => item),
      content: state.active ? await readOptional(join(this.profile(state.active), 'cordis.patch.yml'), '[]\n') : '[]\n',
      revisions: state.revisions.map(({ dependencyRevision: _dependency, ...revision }) => revision),
      operations: state.operations.slice(-30).map(publicOperation) }
  }
  async operation(id: string) {
    await this.snapshot()
    const operation = (await this.state()).operations.find(operation => operation.id === id)
    if (!operation) fail(404, 'DSH_OPERATION_NOT_FOUND', 'Plugin operation not found')
    return publicOperation(operation)
  }
  async submit(input: unknown, expectedRevision: string | undefined, execute: DshPluginExecutor) {
    if (this.closing) fail(503, 'DSH_OPERATION_INTERRUPTED', 'Plugin manager is shutting down')
    const request = parseDshPluginRequest(input)
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const replay = (state: State) => {
      const previous = state.operations.find(operation => operation.key === request.idempotencyKey)
      if (previous && previous.fingerprint !== fingerprint) fail(409, 'DSH_OPERATION_CONFLICT', 'Idempotency key has different content')
      return previous && publicOperation(previous)
    }
    const existing = replay(await this.state()); if (existing) return existing
    const release = await this.lock()
    let transferred = false
    try {
      const state = await this.state()
      const previous = replay(state); if (previous) return previous
      if (expectedRevision === undefined) fail(428, 'DSH_REVISION_REQUIRED', 'If-Match is required')
      if (expectedRevision !== state.revision) fail(412, 'DSH_REVISION_CHANGED', 'Plugin configuration changed; reload before saving')
      await this.recover(state)
      const operation: StoredOperation = { id: randomUUID(), action: request.action, status: 'running',
        createdAt: new Date().toISOString(), key: request.idempotencyKey, fingerprint,
        ...('packageName' in request ? { packageName: request.packageName } : 'packageSpec' in request ? { packageName: request.packageSpec.slice(0, request.packageSpec.lastIndexOf('@')) } : {}) }
      state.operations.push(operation)
      await this.save(state)
      const abort = new AbortController()
      // Own the in-memory slot before starting any asynchronous revision work.
      const slot = { abort, done: Promise.resolve() }
      this.pending.set(operation.id, slot)
      slot.done = this.perform(state, operation, request, execute, abort.signal).finally(async () => {
        try { await release() } finally { this.pending.delete(operation.id) }
      })
      // Read failures remain visible on the next request, without unhandled rejections.
      slot.done.catch(() => {})
      transferred = true
      return publicOperation(operation)
    } finally { if (!transferred) await release() }
  }
  private async perform(state: State, operation: StoredOperation, request: DshPluginRequest, execute: DshPluginExecutor, signal: AbortSignal) {
    try {
      let active: string
      if (request.action === 'rollback') {
        if (!state.revisions.some(revision => revision.id === request.revisionId)) fail(404, 'DSH_REVISION_NOT_FOUND', 'Revision not found')
        await this.inventory(request.revisionId)
        active = request.revisionId
      } else {
        active = operation.id
        const profile = this.profile(active)
        await mkdir(profile, { recursive: true, mode: 0o700 })
        const manifest = state.active ? await this.manifest(state.active) : { name: 'studio-dsh-plugins', private: true, packageManager: 'pnpm@10.33.0', dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }
        const enabled = new Set<string>(manifest.dsh.profile.bundles)
        const old = state.active ? this.profile(state.active) : null
        await atomicJson(join(profile, 'package.json'), manifest)
        await writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 })
        await writeFile(join(profile, 'cordis.patch.yml'), request.action === 'configure' ? request.content : old ? await readOptional(join(old, 'cordis.patch.yml'), '[]\n') : '[]\n', { mode: 0o600 })
        let dependencyRevision = active
        if (['install', 'update', 'remove'].includes(request.action)) {
          if (old) { const lock = await readOptional(join(old, 'pnpm-lock.yaml'), ''); if (lock) await writeFile(join(profile, 'pnpm-lock.yaml'), lock, { mode: 0o600 }) }
          if (request.action === 'install' || request.action === 'update') {
            const name = request.packageSpec.slice(0, request.packageSpec.lastIndexOf('@'))
            if ((request.action === 'update') !== Object.hasOwn(manifest.dependencies, name)) fail(409, 'DSH_OPERATION_CONFLICT', 'Choose install for a new dependency or update for an existing one')
            await execute(dirname(dirname(profile)), ['plugin', '--profile', PROFILE, 'add', request.packageSpec, '--save-exact', '--ignore-scripts'], signal)
          } else if (request.action === 'remove') {
            if (!Object.hasOwn(manifest.dependencies, request.packageName)) fail(404, 'DSH_PLUGIN_NOT_FOUND', 'Dependency not found')
            // Materialize the locked graph before removal, without copying writable packages.
            await execute(dirname(dirname(profile)), ['plugin', '--profile', PROFILE, 'install', '--frozen-lockfile', '--ignore-scripts'], signal)
            await execute(dirname(dirname(profile)), ['plugin', '--profile', PROFILE, 'remove', request.packageName, '--ignore-scripts'], signal)
          }
          const after = await this.manifest(active)
          if (request.action === 'install' || request.action === 'update') {
            const split = request.packageSpec.lastIndexOf('@')
            if (after.dependencies?.[request.packageSpec.slice(0, split)] !== request.packageSpec.slice(split + 1)) fail(422, 'DSH_PLUGIN_OPERATION_FAILED', 'Package command did not install the requested version')
          } else if (request.action === 'remove' && Object.hasOwn(after.dependencies || {}, request.packageName)) fail(422, 'DSH_PLUGIN_OPERATION_FAILED', 'Package command did not remove the dependency')
          // Reconcile may auto-enable bundles; new installs stay off until the
          // user explicitly enables them, and upgrades preserve previous choices.
          after.dsh.profile.bundles = [...enabled].filter(name => after.dsh.profile.bundles.includes(name))
          await atomicJson(join(profile, 'package.json'), after)
        } else if (state.active) {
          dependencyRevision = state.revisions.find(revision => revision.id === state.active)!.dependencyRevision
          await symlink(join(this.profile(dependencyRevision), 'node_modules'), join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
          const lock = await readOptional(join(old!, 'pnpm-lock.yaml'), '')
          if (lock) await writeFile(join(profile, 'pnpm-lock.yaml'), lock, { mode: 0o600 })
        } else {
          await mkdir(join(profile, 'node_modules'), { recursive: true })
        }
        if (request.action === 'toggle') {
          const item = (await this.inventory(active)).find(item => item.name === request.packageName)
          if (!item || item.kind !== 'bundle') fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Only bundle dependencies have a configuration layer')
          if (request.enabled && item.containsBrowserPart) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'This bundle declares a browser component; browser integration is not available')
          manifest.dsh.profile.bundles = request.enabled ? [...new Set([...manifest.dsh.profile.bundles, request.packageName])] : manifest.dsh.profile.bundles.filter((name: string) => name !== request.packageName)
          await atomicJson(join(profile, 'package.json'), manifest)
        }
        const validated = await this.inventory(active)
        if (validated.some(item => item.configuredEnabled && item.containsBrowserPart)) fail(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Enabled bundles must support native ACP')
        signal.throwIfAborted()
        state.revisions.push({ id: active, dependencyRevision, createdAt: new Date().toISOString() })
      }
      signal.throwIfAborted()
      // Pointer and operation outcome publish in one atomic state replacement.
      state.active = active; state.revision = randomUUID()
      operation.status = 'succeeded'; operation.revision = state.revision
    } catch (error) {
      operation.status = 'failed'
      operation.code = error instanceof DshPluginError ? error.code : signal.aborted ? 'DSH_OPERATION_INTERRUPTED' : 'DSH_PLUGIN_OPERATION_FAILED'
    }
    operation.finishedAt = new Date().toISOString()
    await this.save(state)
  }
  async runtimePatches(): Promise<string[]> {
    const state = await this.state()
    if (!state.active) return []
    const packages = await this.inventory(state.active)
    const manifest = await this.manifest(state.active)
    const patches = (manifest.dsh.profile.bundles as string[]).map(name => packages.find(item => item.name === name)?.patchPath).filter((path): path is string => !!path)
    return [...patches, join(this.profile(state.active), 'cordis.patch.yml')]
  }
  async shutdown() {
    this.closing = true
    for (const { abort } of this.pending.values()) abort.abort()
    await Promise.allSettled([...this.pending.values()].map(slot => slot.done))
  }
}

const stores = new Map<string, DshPluginStore>()
export function getDshPluginStore() {
  const root = join(getWebUiHome(), 'coding-agents', 'dsh', 'plugins')
  let store = stores.get(root)
  if (!store) { store = new DshPluginStore(root); stores.set(root, store) }
  return store
}
export async function shutdownDshPluginOperations() { await Promise.all([...stores.values()].map(store => store.shutdown())) }
