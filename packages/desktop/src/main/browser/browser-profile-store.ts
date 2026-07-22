import { randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DesktopBrowserProfile } from './browser-types'

interface BrowserProfilesDocument {
  schema: 1
  activeProfileId: string
  profiles: DesktopBrowserProfile[]
}

function now(): string {
  return new Date().toISOString()
}

function isPathWithin(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeName(input: string): string {
  const name = String(input || '').trim().replace(/[\u0000-\u001f]/g, '')
  if (!name) throw new Error('Profile name is required')
  if (name.length > 80) throw new Error('Profile name is too long')
  return name
}

export class BrowserProfileStore {
  readonly root: string
  readonly profilesFile: string
  private document: BrowserProfilesDocument | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  constructor(root: string, private readonly downloadsRoot: string) {
    this.root = resolve(root)
    this.profilesFile = join(this.root, 'profiles.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await mkdir(join(this.root, 'profiles'), { recursive: true, mode: 0o700 })
    await chmod(join(this.root, 'profiles'), 0o700)
    this.document = await this.readDocument()
    await this.migratePendingProfiles()
    for (const profile of this.document.profiles) {
      await mkdir(profile.sessionPath, { recursive: true, mode: 0o700 })
      await mkdir(profile.downloadPath, { recursive: true, mode: 0o700 })
    }
    await this.persist()
  }

  list(): DesktopBrowserProfile[] {
    return this.requireDocument().profiles.map(profile => ({ ...profile, tabs: [...profile.tabs] }))
  }

  active(): DesktopBrowserProfile {
    const document = this.requireDocument()
    return this.get(document.activeProfileId) || document.profiles[0]
  }

  get(profileId: string): DesktopBrowserProfile | undefined {
    return this.requireDocument().profiles.find(profile => profile.id === profileId)
  }

  async create(name: string): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    const id = randomUUID()
    const createdAt = now()
    const profile: DesktopBrowserProfile = {
      id,
      name: safeName(name),
      sessionPath: join(this.root, 'profiles', id, 'session'),
      downloadPath: join(this.downloadsRoot, id),
      askBeforeDownload: true,
      downloadConflictPolicy: 'uniquify',
      createdAt,
      lastUsedAt: createdAt,
      tabs: ['about:blank'],
    }
    document.profiles.push(profile)
    await mkdir(profile.sessionPath, { recursive: true, mode: 0o700 })
    await mkdir(profile.downloadPath, { recursive: true, mode: 0o700 })
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    profile.name = safeName(name)
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async setActive(profileId: string): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    const profile = this.requireProfile(profileId)
    document.activeProfileId = profileId
    profile.lastUsedAt = now()
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async setTabs(profileId: string, tabs: string[]): Promise<void> {
    const profile = this.requireProfile(profileId)
    profile.tabs = tabs.slice(0, 8).map(url => String(url || 'about:blank'))
    if (profile.tabs.length === 0) profile.tabs = ['about:blank']
    await this.persist()
  }

  async setDownloadDirectory(profileId: string, pathname: string): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    const normalized = await this.validateDirectory(profileId, pathname, 'download')
    profile.downloadPath = normalized
    await mkdir(normalized, { recursive: true, mode: 0o700 })
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async setDownloadPreferences(
    profileId: string,
    preferences: { askBeforeDownload?: boolean; downloadConflictPolicy?: 'ask' | 'uniquify' },
  ): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    if (typeof preferences.askBeforeDownload === 'boolean') profile.askBeforeDownload = preferences.askBeforeDownload
    if (preferences.downloadConflictPolicy === 'ask' || preferences.downloadConflictPolicy === 'uniquify') {
      profile.downloadConflictPolicy = preferences.downloadConflictPolicy
    }
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async scheduleSessionDirectory(profileId: string, pathname: string): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    const normalized = await this.validateDirectory(profileId, pathname, 'session')
    if (normalized === resolve(profile.sessionPath)) return { ...profile, tabs: [...profile.tabs] }
    profile.pendingSessionPath = normalized
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async deleteProfile(profileId: string): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    if (document.profiles.length <= 1) throw new Error('At least one browser profile is required')
    const index = document.profiles.findIndex(profile => profile.id === profileId)
    if (index < 0) throw new Error('Browser profile not found')
    const [removed] = document.profiles.splice(index, 1)
    if (document.activeProfileId === profileId) document.activeProfileId = document.profiles[0].id
    await this.persist()
    return removed
  }

  private async readDocument(): Promise<BrowserProfilesDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.profilesFile, 'utf8')) as BrowserProfilesDocument
      if (parsed?.schema === 1 && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        parsed.profiles = parsed.profiles.map(profile => ({ ...profile, tabs: Array.isArray(profile.tabs) ? profile.tabs : ['about:blank'] }))
        if (!parsed.profiles.some(profile => profile.id === parsed.activeProfileId)) parsed.activeProfileId = parsed.profiles[0].id
        return parsed
      }
    } catch {
      // Create the first managed profile below.
    }
    const id = randomUUID()
    const createdAt = now()
    return {
      schema: 1,
      activeProfileId: id,
      profiles: [{
        id,
        name: 'Default',
        sessionPath: join(this.root, 'profiles', id, 'session'),
        downloadPath: join(this.downloadsRoot, id),
        askBeforeDownload: true,
        downloadConflictPolicy: 'uniquify',
        createdAt,
        lastUsedAt: createdAt,
        tabs: ['about:blank'],
      }],
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistQueue.catch(() => undefined).then(async () => {
      const tempPath = `${this.profilesFile}.${process.pid}.tmp`
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await writeFile(tempPath, `${JSON.stringify(this.requireDocument(), null, 2)}\n`, { mode: 0o600 })
      await rename(tempPath, this.profilesFile)
      await chmod(this.profilesFile, 0o600)
    })
    this.persistQueue = write
    await write
  }

  private requireDocument(): BrowserProfilesDocument {
    if (!this.document) throw new Error('Browser profile store is not initialized')
    return this.document
  }

  private requireProfile(profileId: string): DesktopBrowserProfile {
    const profile = this.get(profileId)
    if (!profile) throw new Error('Browser profile not found')
    return profile
  }

  private async validateDirectory(profileId: string, pathname: string, kind: 'session' | 'download'): Promise<string> {
    const normalized = resolve(String(pathname || '').trim())
    if (!isAbsolute(String(pathname || '').trim())) throw new Error('Directory must be an absolute path')
    if (dirname(normalized) === normalized) throw new Error('A filesystem root cannot be used as a browser directory')
    if (normalized === this.root) throw new Error('The browser data root cannot be used directly')
    for (const profile of this.requireDocument().profiles) {
      for (const [otherKind, other] of [['session', profile.sessionPath], ['download', profile.downloadPath]] as const) {
        if (profile.id === profileId && otherKind === kind) continue
        if (isPathWithin(normalized, other) || isPathWithin(other, normalized)) {
          throw new Error('Browser profile directories cannot overlap')
        }
      }
    }
    try {
      const info = await stat(normalized)
      if (!info.isDirectory()) throw new Error('Selected path is not a directory')
      if (kind === 'session' && (await readdir(normalized)).length > 0) throw new Error('The new profile directory must be empty')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return normalized
  }

  private async migratePendingProfiles(): Promise<void> {
    for (const profile of this.requireDocument().profiles) {
      if (!profile.pendingSessionPath) continue
      const destination = resolve(profile.pendingSessionPath)
      const tempPath = `${destination}.hermes-migration-${process.pid}`
      await rm(tempPath, { recursive: true, force: true })
      try {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await cp(profile.sessionPath, tempPath, { recursive: true, force: false, errorOnExist: true })
        try {
          if ((await readdir(destination)).length > 0) throw new Error('migration destination is no longer empty')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rm(destination, { recursive: true, force: true })
        await rename(tempPath, destination)
        profile.sessionPath = destination
        delete profile.pendingSessionPath
      } catch (error) {
        await rm(tempPath, { recursive: true, force: true })
        console.warn(`[desktop-browser] profile migration failed for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
