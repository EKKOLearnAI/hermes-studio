import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  publish: vi.fn(() => ({ id: 'agent-attachment-message-1' })),
  resolvePath: vi.fn(async () => ({ fullPath: '/workspace/renders/final.png' })),
  storeAttachment: vi.fn(async () => ({
    type: 'image' as const,
    name: 'final.png',
    path: '0123456789abcdef0123456789abcdef.png',
    media_type: 'image/png',
  })),
  action: vi.fn(async () => ({
    ok: true as const,
    path: 'renders/final.png',
    size: 42,
    sha256: 'a'.repeat(64),
  })),
  upload: vi.fn(async () => ({
    ok: true as const,
    path: 'renders/final.png',
    size: 42,
    sha256: 'a'.repeat(64),
  })),
}))

vi.mock('../../packages/server/src/services/hermes/group-chat/runtime', () => ({
  getGroupChatRuntimeServer: () => ({
    getStorage: () => ({
      getRoom: () => ({
        id: 'room-1',
        workspace: '/workspace',
        allowRemoteWorkspaceAccess: 1,
      }),
    }),
    publishAgentAttachmentMessage: mocks.publish,
  }),
}))

vi.mock('../../packages/server/src/services/hermes/group-chat/remote-workspace-auth', () => ({
  beginRemoteWorkspaceGrantOperation: () => ({
    grant: {
      roomId: 'room-1',
      agentId: 'agent-1',
      runId: 'run-1',
      workspace: '/workspace',
    },
    finish: mocks.finish,
  }),
}))

vi.mock('../../packages/server/src/services/hermes/group-chat/remote-workspace-files', () => ({
  MAX_REMOTE_WORKSPACE_TRANSFER_BYTES: 20 * 1024 * 1024,
  openRemoteWorkspaceDownload: vi.fn(),
  performRemoteWorkspaceAction: mocks.action,
  uploadRemoteWorkspaceFile: mocks.upload,
}))

vi.mock('../../packages/server/src/services/hermes/group-chat/workspace-files', () => ({
  resolveGroupWorkspacePath: mocks.resolvePath,
}))

vi.mock('../../packages/server/src/services/hermes/group-chat/attachments', () => ({
  storeAgentGroupChatAttachment: mocks.storeAttachment,
}))

describe('group chat Agent attachment upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes the returned upload path as a separate Agent attachment message', async () => {
    const { uploadRemoteWorkspaceFileContent } = await import(
      '../../packages/server/src/controllers/hermes/group-chat-remote-workspace'
    )
    const headers: Record<string, string> = {
      authorization: 'Bearer valid_grant',
      'content-type': 'application/octet-stream',
      'content-length': '42',
    }
    const ctx: any = {
      query: { path: 'renders/final.png' },
      req: Readable.from([Buffer.alloc(42)]),
      body: undefined,
      status: 200,
      set: vi.fn(),
      get: (name: string) => headers[name.toLowerCase()] || '',
    }

    await uploadRemoteWorkspaceFileContent(ctx)

    expect(mocks.storeAttachment).toHaveBeenCalledWith(
      'room-1',
      '/workspace/renders/final.png',
      'renders/final.png',
    )
    expect(mocks.publish).toHaveBeenCalledWith({
      roomId: 'room-1',
      agentId: 'agent-1',
      runId: 'run-1',
      workspacePath: 'renders/final.png',
      attachment: {
        type: 'image',
        name: 'final.png',
        path: '0123456789abcdef0123456789abcdef.png',
        media_type: 'image/png',
      },
    })
    expect(ctx.body).toMatchObject({
      ok: true,
      path: 'renders/final.png',
      messageId: 'agent-attachment-message-1',
    })
    expect(mocks.finish).toHaveBeenCalledOnce()
  })

  it('does not publish JSON writes as Agent attachment messages', async () => {
    const { remoteWorkspaceAction } = await import(
      '../../packages/server/src/controllers/hermes/group-chat-remote-workspace'
    )
    const ctx: any = {
      request: {
        body: {
          action: 'write',
          path: 'renders/final.png',
          content: 'rendered content',
        },
      },
      body: undefined,
      status: 200,
      set: vi.fn(),
      get: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer valid_grant' : '',
    }

    await remoteWorkspaceAction(ctx)

    expect(mocks.action).toHaveBeenCalledWith('/workspace', {
      action: 'write',
      path: 'renders/final.png',
      content: 'rendered content',
    })
    expect(mocks.storeAttachment).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      ok: true,
      path: 'renders/final.png',
      size: 42,
      sha256: 'a'.repeat(64),
    })
    expect(mocks.finish).toHaveBeenCalledOnce()
  })

  it('does not publish read-only JSON actions', async () => {
    mocks.action.mockResolvedValueOnce({ ok: true, path: '', entries: [] } as any)
    const { remoteWorkspaceAction } = await import(
      '../../packages/server/src/controllers/hermes/group-chat-remote-workspace'
    )
    const ctx: any = {
      request: { body: { action: 'list', path: '' } },
      body: undefined,
      status: 200,
      set: vi.fn(),
      get: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer valid_grant' : '',
    }

    await remoteWorkspaceAction(ctx)

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true, path: '', entries: [] })
    expect(mocks.finish).toHaveBeenCalledOnce()
  })
})
