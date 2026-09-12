import { createRequire } from 'node:module'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { DshPluginError } from './errors'
import { dshInstallation, dshPackageDirectory } from './installation'
import { createHash } from 'node:crypto'
import { readDshPluginMetadata } from './plugin-metadata'

export interface DshNativePluginEntry {
  entryId: string
  title?: string
  description?: string
  moduleName: string
  configuredEnabled: boolean | 'conditional'
  runtimePhase: null
  groupPath: string[]
}
export interface DshNativePreset {
  id: string; name: string; description: string; trust: 'system' | 'user'
  sourcePath: string; isDefault: boolean; entries: DshNativePluginEntry[]; error?: string
}

/** Inspect native Cordis compositions as data, preserving expressions without executing them. */
export function nativePluginEntries(content: string): DshNativePluginEntry[] {
  const document = parseDocument(content, { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid composition')
  const entries: DshNativePluginEntry[] = []
  const scan = (sequence: unknown, parents: string[], inherited: boolean | 'conditional') => {
    if (!isSeq(sequence)) throw new Error('Invalid group')
    for (const [index, row] of sequence.items.entries()) {
      if (!isMap(row) || typeof row.get('name') !== 'string') throw new Error('Invalid plugin row')
      const entryId = typeof row.get('id') === 'string' ? String(row.get('id')) : String(index + 1)
      const disabled = row.get('disabled', true)
      const own = disabled === undefined ? true : isScalar(disabled) && !disabled.tag && typeof disabled.value === 'boolean' ? !disabled.value : 'conditional'
      const enabled = inherited === false || own === false ? false : inherited === 'conditional' || own === 'conditional' ? 'conditional' : true
      if (row.get('group') === true) scan(row.get('config', true), [...parents, entryId], enabled)
      else entries.push({ entryId, moduleName: String(row.get('name')), configuredEnabled: enabled, runtimePhase: null, groupPath: parents })
    }
  }
  scan(document.contents, [], true)
  return entries
}
async function optionalDocument(path: string): Promise<YAMLMap | null> {
  try {
    const doc = parseDocument(await readFile(path, 'utf8'), { logLevel: 'silent' })
    if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error('Invalid metadata')
    return isMap(doc.contents) ? doc.contents : null
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}
function within(root: string, path: string) { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel) }

/** Resolve the installed CLI's own dependency graph, not Studio's supplemental package list. */
export async function readNativeDshPluginInventory(command: string, sourceHome: string) {
  const installation = await dshInstallation(command)
  let packagePath: string
  try { packagePath = createRequire(installation).resolve('@deepseek-ai/dsh-agent-presets/package.json') }
  catch { throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', 'This DSH installation does not expose native presets') }
  const inventory = await readNativeDshPresetRoots(packagePath, sourceHome)
  const cache = new Map<string, ReturnType<typeof readDshPluginMetadata>>()
  await Promise.all(inventory.presets.flatMap(preset => preset.entries.map(async entry => {
    if (!cache.has(entry.moduleName)) cache.set(entry.moduleName, readDshPluginMetadata(entry.moduleName, [installation, join(sourceHome, 'profiles/web/package.json')]))
    const metadata = await cache.get(entry.moduleName)
    if (metadata) { entry.title = metadata.title; entry.description = metadata.description }
  })))
  return { ...inventory, ...await readDshWebPackages(installation, sourceHome) }
}

/** Package installation and preset composition are separate native inventories. */
export async function readDshWebPackages(installation: string, sourceHome: string) {
  const sourcePath = join(sourceHome, 'profiles/web/package.json')
  let content = '{}'
  try { content = await readFile(sourcePath, 'utf8') } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  const manifest = JSON.parse(content)
  const bundles: string[] = manifest.dsh?.profile?.bundles || []
  const packages = await Promise.all(Object.entries(manifest.dependencies || {}).map(async ([name, requested]) => {
    const entry = { name, title: name, description: '', requested: String(requested), version: '', bundle: bundles.includes(name), containsBrowserPart: false, sourcePath, error: '' }
    try {
      const directory = await dshPackageDirectory(name, [installation, sourcePath])
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      entry.title = typeof pkg.displayName === 'string' ? pkg.displayName : String(pkg.name || name); entry.description = typeof pkg.description === 'string' ? pkg.description : ''; entry.version = String(pkg.version || ''); entry.containsBrowserPart = !!pkg.dsh?.client
    } catch { entry.error = 'DSH_DEPENDENCY_UNAVAILABLE' }
    return entry
  }))
  return { web: { profile: 'web' as const, sourcePath, revision: createHash('sha256').update(content).digest('hex'), packages } }
}

export async function readNativeDshPresetRoots(packagePath: string, sourceHome: string) {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  const settings = await optionalDocument(join(sourceHome, 'settings.yaml'))
  const selected = settings?.getIn(['agent-presets', 'default'])
  const defaultPreset = typeof selected === 'string' ? selected : 'standard'
  const roots = [{ path: join(dirname(packagePath), 'presets'), trust: 'system' as const }, { path: join(sourceHome, '.agent-presets'), trust: 'user' as const }]
  const presets: DshNativePreset[] = []
  for (const root of roots) {
    let directories
    try { directories = await readdir(root.path, { withFileTypes: true }) }
    catch (error: any) { if (error.code === 'ENOENT') continue; throw error }
    const canonical = await realpath(root.path)
    const found: Array<DshNativePreset & { order: number }> = []
    for (const directory of directories) {
      if (!directory.isDirectory() && !directory.isSymbolicLink()) continue
      const path = join(root.path, directory.name)
      try { if (!within(canonical, await realpath(path)) || !(await stat(path)).isDirectory()) continue } catch { continue }
      const sourcePath = join(path, 'agent.cordis.yml')
      const preset: DshNativePreset & { order: number } = { id: directory.name, name: directory.name, description: '', trust: root.trust, sourcePath, isDefault: directory.name === defaultPreset, entries: [], order: Number.MAX_SAFE_INTEGER }
      try {
        const metadata = await optionalDocument(join(path, 'preset.yml'))
        for (const key of ['name', 'description'] as const) if (typeof metadata?.get(key) === 'string') preset[key] = String(metadata.get(key))
        if (typeof metadata?.get('order') === 'number') preset.order = Number(metadata.get('order'))
        if (!within(canonical, await realpath(sourcePath))) throw new Error('Composition escapes root')
        preset.entries = nativePluginEntries(await readFile(sourcePath, 'utf8'))
      } catch { preset.error = 'DSH_COMPOSITION_UNREADABLE' }
      found.push(preset)
    }
    found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    for (const { order: _order, ...preset } of found) if (!presets.some(existing => existing.id === preset.id)) presets.push(preset)
  }
  return { source: 'native-presets' as const, sourceHome, packageVersion: String(manifest.version || ''), defaultPreset, runtimeConnected: false as const,
    // This discovery is intentionally named: custom roots/overlays and live
    // fiber phases need the Web host's authenticated pluginInventory.list.
    discovery: 'shipped-and-user-roots' as const, presets }
}
