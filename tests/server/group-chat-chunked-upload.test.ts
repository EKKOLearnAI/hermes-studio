import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let appHome = ''

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    get appHome() {
      return appHome
    },
  },
}))

describe('group chat chunked uploads', () => {
  beforeEach(async () => {
    appHome = await mkdtemp(join(tmpdir(), 'hermes-group-upload-'))
  })

  afterEach(async () => {
    await rm(appHome, { recursive: true, force: true })
  })

  it('writes ordered chunks and completes into the private room attachment store', async () => {
    const {
      appendGroupChatUploadChunk,
      completeGroupChatUpload,
      openGroupChatUpload,
    } = await import('../../packages/server/src/modules/studio/services/group-chat/chunked-upload')
    const { getGroupChatAttachmentPath } = await import(
      '../../packages/server/src/modules/studio/services/group-chat/attachments'
    )
    const id = 'group_upload_test_1234'
    await openGroupChatUpload({ id, owner: '7', roomId: 'room-1', name: 'clip.mp4', size: 5 })
    await expect(appendGroupChatUploadChunk({
      id,
      owner: '7',
      roomId: 'room-1',
      offset: 0,
      bytes: Uint8Array.from([1, 2, 3]),
    })).resolves.toMatchObject({ nextOffset: 3, done: false })
    await expect(appendGroupChatUploadChunk({
      id,
      owner: '7',
      roomId: 'room-1',
      offset: 3,
      bytes: Uint8Array.from([4, 5]),
    })).resolves.toMatchObject({ nextOffset: 5, done: true })

    const completed = await completeGroupChatUpload({ id, owner: '7', roomId: 'room-1' })
    expect(completed.name).toBe('clip.mp4')
    expect(completed.path).toMatch(/^[a-f0-9]{32}\.mp4$/)
    const storedPath = getGroupChatAttachmentPath('room-1', completed.path)
    expect(storedPath).toBeTruthy()
    expect(await readFile(storedPath!)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects another member and out-of-order chunks', async () => {
    const { appendGroupChatUploadChunk, openGroupChatUpload } = await import(
      '../../packages/server/src/modules/studio/services/group-chat/chunked-upload'
    )
    const id = 'group_upload_owner_1234'
    await openGroupChatUpload({ id, owner: '7', roomId: 'room-1', name: 'clip.mp4', size: 2 })
    await expect(appendGroupChatUploadChunk({
      id,
      owner: '8',
      roomId: 'room-1',
      offset: 0,
      bytes: Uint8Array.from([1]),
    })).rejects.toMatchObject({ code: 'upload_forbidden', status: 403 })
    await expect(appendGroupChatUploadChunk({
      id,
      owner: '7',
      roomId: 'room-1',
      offset: 1,
      bytes: Uint8Array.from([1]),
    })).rejects.toMatchObject({ code: 'invalid_upload_offset', status: 409 })
  })
})
