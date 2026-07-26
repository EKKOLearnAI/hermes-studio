// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  request: vi.fn(),
  getApiKey: vi.fn(() => ''),
  fetchAuthenticatedBlob: vi.fn(),
  saveBlob: vi.fn(),
}))

vi.mock('../../packages/client/src/api/client', () => ({
  request: apiMock.request,
  getApiKey: apiMock.getApiKey,
}))

vi.mock('../../packages/client/src/api/hermes/binary-content', () => ({
  fetchAuthenticatedBlob: apiMock.fetchAuthenticatedBlob,
  saveBlob: apiMock.saveBlob,
}))

import {
  fetchGroupWorkspaceFileBlob,
  joinRoomByCode,
  listRooms,
} from '../../packages/client/src/api/hermes/group-chat'

describe('group chat invite REST client', () => {
  beforeEach(() => {
    apiMock.request.mockReset()
    apiMock.request.mockResolvedValue({ room: { id: 'room-1' } })
    apiMock.fetchAuthenticatedBlob.mockReset()
    apiMock.fetchAuthenticatedBlob.mockResolvedValue(new Blob(['data']))
    localStorage.clear()
  })

  it('URL-encodes exact invite bytes and carries the signed local subject credential', async () => {
    const code = ' A/B?#MiXeD '
    localStorage.setItem('gc_local_credential', 'signed-local-credential')

    await joinRoomByCode(code)

    expect(apiMock.request).toHaveBeenCalledWith(
      `/api/hermes/group-chat/rooms/join/${encodeURIComponent(code)}`,
      {
        headers: {
          'X-Group-Chat-Local-Credential': 'signed-local-credential',
        },
      },
    )
  })

  it('carries the signed local subject on discovery and binary workspace reads', async () => {
    localStorage.setItem('gc_local_credential', 'signed-local-credential')
    const signal = new AbortController().signal

    await listRooms()
    await fetchGroupWorkspaceFileBlob('room/one', 'folder/file.txt', signal)

    expect(apiMock.request).toHaveBeenCalledWith('/api/hermes/group-chat/rooms', {
      headers: { 'X-Group-Chat-Local-Credential': 'signed-local-credential' },
    })
    expect(apiMock.fetchAuthenticatedBlob).toHaveBeenCalledWith(
      '/api/hermes/group-chat/rooms/room%2Fone/workspace-file/content?path=folder%2Ffile.txt',
      {
        signal,
        headers: { 'X-Group-Chat-Local-Credential': 'signed-local-credential' },
      },
    )
  })
})
