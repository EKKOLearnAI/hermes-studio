import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'
import { isAllowedBrowserRequest, isAllowedBrowserSubresource, normalizeBrowserUrl, publicBrowserUrl, redactBrowserText } from '../../packages/desktop/src/main/browser/browser-url'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop browser security primitives', () => {
  it('keeps numbered marks for a multi-selection annotation session', async () => {
    const source = await readFile('packages/desktop/src/main/browser/browser-manager.ts', 'utf8')
    expect(source).toContain("box.setAttribute('data-hermes-browser-annotation-mark', String(marker))")
    expect(source).toContain('this.annotationMarkerCounts.set(tabId, marker)')
    expect(source).toContain('screenshot: whole')
    expect(source).toContain('async clearAnnotations(tabId: string)')
    expect(source).not.toContain('const cropped = image.crop')
  })

  it('allows normal web pages but blocks privileged schemes, credentials, and metadata endpoints', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('about:blank', { allowBlank: true })).toBe('about:blank')
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/HTTP and HTTPS/)
    expect(() => normalizeBrowserUrl('https://user:secret@example.com')).toThrow(/credentials/)
    expect(() => normalizeBrowserUrl('http://169.254.169.254/latest/meta-data')).toThrow(/blocked/)
    expect(isAllowedBrowserRequest('javascript:alert(1)')).toBe(false)
    expect(isAllowedBrowserSubresource('data:image/png;base64,AA==')).toBe(true)
    expect(isAllowedBrowserSubresource('file:///tmp/secret')).toBe(false)
    expect(publicBrowserUrl('https://example.com/callback?code=secret-code&view=ok#access_token=secret')).toBe('https://example.com/callback?code=%5Bredacted%5D&view=ok#[redacted]')
    expect(redactBrowserText('Authorization: Bearer very.secret.token')).toBe('Authorization: Bearer [redacted]')
  })

  it('persists owner-only isolated profiles and rejects overlapping or non-empty session paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-profile-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const downloadRoot = join(root, 'downloads')
    const store = new BrowserProfileStore(stateRoot, downloadRoot)
    await store.initialize()
    const first = store.active()
    const second = await store.create('Work')

    expect(first.id).not.toBe(second.id)
    expect(first.sessionPath).not.toBe(second.sessionPath)
    await expect(store.setDownloadDirectory(second.id, first.downloadPath)).rejects.toThrow(/overlap/)
    await expect(store.setDownloadDirectory(second.id, process.platform === 'win32' ? 'C:\\' : '/')).rejects.toThrow(/filesystem root/)

    const nonEmpty = join(root, 'non-empty')
    await mkdir(nonEmpty, { recursive: true })
    await writeFile(join(nonEmpty, 'keep.txt'), 'do not remove')
    await expect(store.scheduleSessionDirectory(second.id, nonEmpty)).rejects.toThrow(/must be empty/)

    const document = JSON.parse(await readFile(join(stateRoot, 'profiles.json'), 'utf8'))
    expect(document.schema).toBe(1)
    if (process.platform !== 'win32') expect((await stat(join(stateRoot, 'profiles.json'))).mode & 0o077).toBe(0)
  })

  it('migrates a pending session directory on restart and preserves the old copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-profile-migrate-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const store = new BrowserProfileStore(stateRoot, join(root, 'downloads'))
    await store.initialize()
    const profile = store.active()
    await writeFile(join(profile.sessionPath, 'cookie-state'), 'persisted')
    const destination = join(root, 'custom-session')
    await store.scheduleSessionDirectory(profile.id, destination)

    const restarted = new BrowserProfileStore(stateRoot, join(root, 'downloads'))
    await restarted.initialize()

    expect(restarted.active().sessionPath).toBe(destination)
    expect(restarted.active().pendingSessionPath).toBeUndefined()
    expect(await readFile(join(destination, 'cookie-state'), 'utf8')).toBe('persisted')
    expect(await readFile(join(profile.sessionPath, 'cookie-state'), 'utf8')).toBe('persisted')
  })

  it('keeps the old session path when a pending migration destination becomes non-empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-profile-rollback-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const store = new BrowserProfileStore(stateRoot, join(root, 'downloads'))
    await store.initialize()
    const profile = store.active()
    const destination = join(root, 'custom-session')
    await store.scheduleSessionDirectory(profile.id, destination)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'appeared-later'), 'keep')

    const restarted = new BrowserProfileStore(stateRoot, join(root, 'downloads'))
    await restarted.initialize()

    expect(restarted.active().sessionPath).toBe(profile.sessionPath)
    expect(restarted.active().pendingSessionPath).toBe(destination)
    expect(await readFile(join(destination, 'appeared-later'), 'utf8')).toBe('keep')
  })
})
