import { describe, expect, it } from 'vitest'
import {
  RelayDownloadSessionError,
  RelayDownloadSessions,
} from '../../packages/server/src/modules/studio/services/app-relay/download-session'

describe('RelayDownloadSessions diagnostics', () => {
  it('finishes at the declared byte length without requiring an extra EOF read', async () => {
    let pullCount = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1
        if (pullCount === 1) {
          controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5, 6]))
          return
        }
        controller.error(new Error('closing stream reported as failed'))
      },
    })
    const sessions = new RelayDownloadSessions()
    const download = sessions.create('owner-complete', new Response(body, {
      headers: { 'content-length': '6' },
    }))

    await expect(sessions.read('owner-complete', download.id)).resolves.toMatchObject({
      bodyBytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      receivedBytes: 6,
      totalBytes: 6,
      done: true,
    })
    expect(pullCount).toBe(1)
  })

  it('preserves source read failures with the last confirmed progress', async () => {
    let pullCount = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1
        if (pullCount === 1) {
          controller.enqueue(Uint8Array.from([1, 2, 3]))
          return
        }
        controller.error(new Error('source connection reset'))
      },
    })
    const sessions = new RelayDownloadSessions()
    const download = sessions.create('owner-1', new Response(body, {
      headers: { 'content-length': '6' },
    }))

    await expect(sessions.read('owner-1', download.id, 3)).resolves.toMatchObject({
      receivedBytes: 3,
      totalBytes: 6,
      done: false,
    })

    try {
      await sessions.read('owner-1', download.id, 3)
      throw new Error('expected the source read to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(RelayDownloadSessionError)
      expect(error).toMatchObject({
        code: 'download_source_read_failed',
        causeMessage: 'source connection reset',
        diagnostic: {
          downloadId: download.id,
          ownerId: 'owner-1',
          sessionFound: true,
          receivedBytes: 3,
          totalBytes: 6,
          sourceBytes: 3,
          attemptedChunks: 2,
          completedChunks: 1,
          busy: true,
        },
      })
    }
  })

  it('distinguishes a missing download session from a zero-byte session', async () => {
    const sessions = new RelayDownloadSessions()

    await expect(sessions.read('owner-2', 'missing-download')).rejects.toMatchObject({
      code: 'download_not_found',
      diagnostic: {
        downloadId: 'missing-download',
        ownerId: 'owner-2',
        sessionFound: false,
      },
    })
  })
})
