import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authenticateRemoteWorkspaceGrant,
  beginRemoteWorkspaceGrantOperation,
  issueRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
  revokeRemoteWorkspaceGrantsForRun,
  waitForRemoteWorkspaceGrantOperations,
} from '../../packages/server/src/services/hermes/group-chat/remote-workspace-auth'
import { performRemoteWorkspaceAction } from '../../packages/server/src/services/hermes/group-chat/remote-workspace-files'

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
})
