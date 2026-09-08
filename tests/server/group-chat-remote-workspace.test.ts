import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authenticateRemoteWorkspaceGrant,
  beginRemoteWorkspaceGrantOperation,
  issueRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
  revokeRemoteWorkspaceGrantsForRun,
  waitForRemoteWorkspaceGrantOperations,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'
import {
  MAX_REMOTE_WORKSPACE_TRANSFER_BYTES,
  openRemoteWorkspaceDownload,
  performRemoteWorkspaceAction,
  uploadRemoteWorkspaceFile,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-files'

describe('group chat remote workspace access', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    resetRemoteWorkspaceGrantsForTest()
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'group-chat-remote-workspace-'))
    temporaryDirectories.push(path)
    return path
  }

  it('binds short-lived grants to one run and revokes them immediately', () => {
    const issued = issueRemoteWorkspaceGrant({
      runId: 'run-1',
      roomId: 'room-1',
      agentId: 'agent-1',
      workspace: '/workspace/room-1',
      now: 1_000,
    })

    expect(authenticateRemoteWorkspaceGrant(issued.token, 1_001)).toEqual(issued.grant)
    expect(authenticateRemoteWorkspaceGrant(issued.token, issued.grant.expiresAt)).toBeNull()

    const second = issueRemoteWorkspaceGrant({
      runId: 'run-2',
      roomId: 'room-1',
      agentId: 'agent-1',
      workspace: '/workspace/room-1',
      now: 2_000,
    })
    revokeRemoteWorkspaceGrantsForRun('run-2')
    expect(authenticateRemoteWorkspaceGrant(second.token, 2_001)).toBeNull()
  })

  it('waits for an authenticated file operation to finish after revoking its run', async () => {
    const issued = issueRemoteWorkspaceGrant({
      runId: 'run-active',
      roomId: 'room-1',
      agentId: 'agent-1',
      workspace: '/workspace/room-1',
    })
    const operation = beginRemoteWorkspaceGrantOperation(issued.token)
    expect(operation?.grant).toMatchObject({ runId: 'run-active' })

    let drained = false
    const waiting = waitForRemoteWorkspaceGrantOperations('run-active').then(() => {
      drained = true
    })
    revokeRemoteWorkspaceGrantsForRun('run-active')
    await Promise.resolve()
    expect(drained).toBe(false)

    operation?.finish()
    await waiting
    expect(drained).toBe(true)
  })

  it('reads and atomically writes only relative non-sensitive files with conflict checks', async () => {
    const root = await workspace()

    const created = await performRemoteWorkspaceAction(root, {
      action: 'write',
      path: 'notes/todo.txt',
      content: 'first',
    })
    expect(created).toMatchObject({ ok: true, path: 'notes/todo.txt', size: 5 })

    const read = await performRemoteWorkspaceAction(root, {
      action: 'read',
      path: 'notes/todo.txt',
    })
    expect(read).toMatchObject({ content: 'first', sha256: created.sha256 })

    await expect(performRemoteWorkspaceAction(root, {
      action: 'write',
      path: 'notes/todo.txt',
      content: 'unsafe overwrite',
    })).rejects.toMatchObject({ code: 'workspace_conflict', status: 409 })

    const updated = await performRemoteWorkspaceAction(root, {
      action: 'write',
      path: 'notes/todo.txt',
      content: 'second',
      expectedSha256: read.sha256,
    })
    expect(await readFile(join(root, 'notes/todo.txt'), 'utf8')).toBe('second')

    await expect(performRemoteWorkspaceAction(root, {
      action: 'delete',
      path: 'notes/todo.txt',
      expectedSha256: read.sha256,
    })).rejects.toMatchObject({ code: 'workspace_conflict', status: 409 })
    await expect(performRemoteWorkspaceAction(root, {
      action: 'delete',
      path: 'notes/todo.txt',
      expectedSha256: updated.sha256,
    })).resolves.toMatchObject({ ok: true })
  })

  it('blocks traversal, sensitive files, and symbolic links', async () => {
    const root = await workspace()
    await writeFile(join(root, '.env'), 'SECRET=value')

    await expect(performRemoteWorkspaceAction(root, {
      action: 'read',
      path: '../outside.txt',
    })).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(performRemoteWorkspaceAction(root, {
      action: 'read',
      path: '.env',
    })).rejects.toMatchObject({ code: 'permission_denied', status: 403 })

    if (process.platform !== 'win32') {
      await symlink('/etc/hosts', join(root, 'hosts-link'))
      await expect(performRemoteWorkspaceAction(root, {
        action: 'read',
        path: 'hosts-link',
      })).rejects.toMatchObject({ code: 'invalid_path' })
      const listed = await performRemoteWorkspaceAction(root, { action: 'list', path: '' })
      expect(listed.entries).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'hosts-link' }),
      ]))
    }
  })

  it('streams binary uploads and downloads with overwrite conflict protection', async () => {
    const root = await workspace()
    const firstBytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47])
    const created = await uploadRemoteWorkspaceFile(
      root,
      'artifacts/image.bin',
      Readable.from([firstBytes.subarray(0, 2), firstBytes.subarray(2)]),
    )

    expect(created).toMatchObject({
      ok: true,
      path: 'artifacts/image.bin',
      size: firstBytes.length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await readFile(join(root, 'artifacts/image.bin'))).toEqual(firstBytes)

    const download = await openRemoteWorkspaceDownload(root, 'artifacts/image.bin')
    const downloaded: Buffer[] = []
    for await (const chunk of download.stream) downloaded.push(Buffer.from(chunk))
    expect(Buffer.concat(downloaded)).toEqual(firstBytes)
    expect(download.sha256).toBe(created.sha256)

    await expect(uploadRemoteWorkspaceFile(
      root,
      'artifacts/image.bin',
      Readable.from([Buffer.from('unsafe overwrite')]),
    )).rejects.toMatchObject({ status: 409, code: 'workspace_conflict' })

    const replacement = Buffer.from([0x01, 0x02, 0x03])
    await expect(uploadRemoteWorkspaceFile(
      root,
      'artifacts/image.bin',
      Readable.from([replacement]),
      created.sha256,
    )).resolves.toMatchObject({ ok: true, size: replacement.length })
    expect(await readFile(join(root, 'artifacts/image.bin'))).toEqual(replacement)
  })

  it('stops oversized binary uploads and removes the temporary file', async () => {
    const root = await workspace()

    await expect(uploadRemoteWorkspaceFile(
      root,
      'artifacts/oversized.bin',
      Readable.from([Buffer.alloc(MAX_REMOTE_WORKSPACE_TRANSFER_BYTES + 1)]),
    )).rejects.toMatchObject({ status: 413, code: 'file_too_large' })

    await expect(readFile(join(root, 'artifacts/oversized.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readdir(join(root, 'artifacts'))).toEqual([])
  })
})
