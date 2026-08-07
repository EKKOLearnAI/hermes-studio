import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { canDownloadPath, isDownloadPathWithinProfile } from '../../packages/server/src/routes/hermes/download'

describe('download path authorization', () => {
  it('keeps regular admins inside their resolved profile directory without depending on host paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-download-auth-'))
    const profileDir = join(root, 'profiles', 'he')
    const ownFile = join(profileDir, 'workspace', 'report.pdf')
    const outsideFile = join(root, 'config.yaml')
    await mkdir(join(profileDir, 'workspace'), { recursive: true })
    await writeFile(ownFile, 'report')
    await writeFile(outsideFile, 'private')

    try {
      await expect(isDownloadPathWithinProfile(ownFile, profileDir)).resolves.toBe(true)
      await expect(isDownloadPathWithinProfile(outsideFile, profileDir)).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves super admin absolute-path downloads', async () => {
    const ctx = {
      state: {
        user: { id: 1, username: 'kosmo', role: 'super_admin' },
        profile: { name: 'default' },
      },
    } as any

    await expect(canDownloadPath(ctx, '/etc/hostname')).resolves.toBe(true)
  })

  it('rejects symlinks that escape the authorized profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-download-auth-'))
    const profileDir = join(root, 'profiles', 'he')
    const outsideFile = join(root, 'private.txt')
    await mkdir(profileDir, { recursive: true })
    await writeFile(outsideFile, 'private')
    await symlink(outsideFile, join(profileDir, 'escape.txt'))

    try {
      await expect(isDownloadPathWithinProfile(join(profileDir, 'escape.txt'), profileDir)).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a stale profile binding whose directory does not exist', async () => {
    const ctx = {
      state: {
        user: { id: 2, username: 'he', role: 'admin' },
        profile: { name: 'deleted-profile' },
      },
    } as any

    await expect(canDownloadPath(ctx, '/home/hermes/.hermes/config.yaml')).resolves.toBe(false)
  })

  it('allows regular admins to download files from their profile upload directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-upload-auth-'))
    const uploadDir = join(root, 'upload', 'he')
    const uploadFile = join(uploadDir, 'report.pdf')
    await mkdir(uploadDir, { recursive: true })
    await writeFile(uploadFile, 'report')
    const ctx = {
      state: {
        user: { id: 2, username: 'he', role: 'admin' },
        profile: { name: 'he' },
      },
    } as any

    try {
      await expect(canDownloadPath(ctx, uploadFile, {
        profileDir: join(root, 'profiles', 'he'),
        uploadDir,
      })).resolves.toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
