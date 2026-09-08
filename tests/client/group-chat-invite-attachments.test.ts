// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  getBaseUrlValue: () => 'https://chat.example.test',
  getApiKey: () => 'account-token',
}))
vi.stubGlobal('fetch', fetchMock)

describe('invite-scoped group chat attachment client', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('builds a preview URL from only the stored filename and invite code', async () => {
    const { getGroupChatAttachmentUrl } = await import('@/api/studio/group-chat-attachments')

    expect(getGroupChatAttachmentUrl(
      { roomId: 'room-1', inviteCode: ' ROOM1 ' },
      '/private/group-chat/room-hash/stored.png',
      '访客图片.png',
    )).toBe(
      'https://chat.example.test/api/studio/group-chat/invites/ROOM1/attachments/stored.png?name=%E8%AE%BF%E5%AE%A2%E5%9B%BE%E7%89%87.png',
    )
    expect(getGroupChatAttachmentUrl(
      { roomId: 'room-1', inviteCode: 'ROOM1' },
      '../other-room/stored.png',
    ))
      .toBe('https://chat.example.test/api/studio/group-chat/invites/ROOM1/attachments/stored.png')
    expect(getGroupChatAttachmentUrl(
      { roomId: 'room-1' },
      '/private/group-chat/room-hash/stored.png',
    )).toBe('https://chat.example.test/api/studio/group-chat/rooms/room-1/attachments/stored.png?token=account-token')
  })

  it('uploads files only through the matching group chat attachment endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        files: [{ name: 'image.png', path: '0123456789abcdef0123456789abcdef.png' }],
      }),
    })
    const { uploadGroupChatAttachments } = await import('@/api/studio/group-chat-attachments')
    const file = new File(['png'], 'image.png', { type: 'image/png' })

    await expect(uploadGroupChatAttachments({ roomId: 'room-1', inviteCode: 'ROOM1' }, [{
      name: 'image.png',
      file,
    }])).resolves.toEqual([{ name: 'image.png', path: '0123456789abcdef0123456789abcdef.png' }])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chat.example.test/api/studio/group-chat/invites/ROOM1/attachments',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData), headers: {} }),
    )

    fetchMock.mockClear()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ files: [] }),
    })
    await uploadGroupChatAttachments({ roomId: 'room-1' }, [{ name: 'image.png', file }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chat.example.test/api/studio/group-chat/rooms/room-1/attachments',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer account-token' },
      }),
    )
  })
})
