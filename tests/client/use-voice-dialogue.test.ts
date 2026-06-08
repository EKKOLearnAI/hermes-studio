// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createVoiceEventSequencer } from '../../packages/client/src/utils/voiceDialogueEvents'
import { useVoiceDialogue } from '../../packages/client/src/composables/useVoiceDialogue'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function localStorageSnapshot(): string {
  return JSON.stringify(Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index) || ''
      return [key, localStorage.getItem(key)]
    }),
  ))
}

describe('createVoiceEventSequencer', () => {
  it('emits monotonic seq/id pairs and preserves explicit timestamps', () => {
    const nextEvent = createVoiceEventSequencer('session-1')

    const first = nextEvent('capture.started', { captureId: 'capture-1', timestamp: '2026-06-06T00:00:00.000Z' })
    const second = nextEvent('turn.started', { turnId: 'turn-1' })

    expect(first.seq).toBe(1)
    expect(first.id).toBe('session-1:1')
    expect(first.timestamp).toBe('2026-06-06T00:00:00.000Z')
    expect(second.seq).toBe(2)
    expect(second.id).toBe('session-1:2')
    expect(second.timestamp).toMatch(/Z$/)
  })
})

describe('useVoiceDialogue', () => {
  it('transcribes recorded audio and sends the normalized transcript', async () => {
    const audio = new Blob(['voice'])
    const sendMessage = vi.fn()
    const transcribe = vi.fn().mockResolvedValue({ text: '  hello   hermes  ' })
    const dialogue = useVoiceDialogue({ transcribe, sendMessage })

    const { captureId } = await dialogue.beginCapture()
    await dialogue.transcribeAndSend(captureId, audio)

    expect(transcribe).toHaveBeenCalledWith(audio)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('hello hermes')
    expect(dialogue.transcript.value).toBe('')
    expect(dialogue.status.value).toBe('idle')
    expect(dialogue.activeCaptureId.value).toBeNull()
  })

  it('does not persist backend STT audio blobs or transcripts to localStorage', async () => {
    localStorage.clear()
    const transcriptSentinel = 'backend transcript sentinel'
    const audioSentinel = 'backend audio sentinel'
    const sendMessage = vi.fn()
    const audio = new Blob([audioSentinel], { type: 'audio/webm' })
    const dialogue = useVoiceDialogue({
      transcribe: vi.fn().mockResolvedValue({ text: transcriptSentinel }),
      sendMessage,
    })

    const { captureId } = await dialogue.beginCapture()
    await dialogue.transcribeAndSend(captureId, audio)

    const stored = localStorageSnapshot()
    expect(sendMessage).toHaveBeenCalledWith(transcriptSentinel)
    expect(stored).not.toContain(transcriptSentinel)
    expect(stored).not.toContain(audioSentinel)
  })

  it('drops stale transcript callbacks by captureId', async () => {
    const sendMessage = vi.fn()
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'new command' }),
    })

    const first = await dialogue.beginCapture()
    const second = await dialogue.beginCapture()

    await dialogue.commitTranscript(first.captureId, 'old command')
    await dialogue.commitTranscript(second.captureId, 'new command')

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('new command')
  })

  it('does not persist browser transcripts to localStorage', async () => {
    localStorage.clear()
    const transcriptSentinel = 'browser transcript sentinel'
    const sendMessage = vi.fn()
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const { captureId } = await dialogue.beginCapture()
    await dialogue.commitTranscript(captureId, transcriptSentinel)

    const stored = localStorageSnapshot()
    expect(sendMessage).toHaveBeenCalledWith(transcriptSentinel)
    expect(stored).not.toContain(transcriptSentinel)
  })

  it('emits turn and capture events in sequence', async () => {
    const dialogue = useVoiceDialogue({
      sendMessage: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const { captureId } = await dialogue.beginCapture()
    await dialogue.commitTranscript(captureId, 'hello world')

    const relevantTypes = dialogue.events.value
      .map(event => event.type)
      .filter(type => ['capture.started', 'transcript.done', 'turn.started', 'turn.ended'].includes(type))

    expect(relevantTypes).toEqual([
      'capture.started',
      'transcript.done',
      'turn.started',
      'turn.ended',
    ])
  })

  it('retains only the last 50 events', () => {
    const dialogue = useVoiceDialogue({
      sendMessage: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    for (let index = 0; index < 55; index += 1) {
      dialogue.markOutputStarted({ index })
    }

    expect(dialogue.events.value).toHaveLength(50)
    const seqs = dialogue.events.value.map(event => event.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(seqs[0]).toBe(seqs[seqs.length - 1] - 49)
  })

  it('drops stale transcribe results when capture changes before transcribe resolves', async () => {
    const deferred = createDeferred<{ text: string }>()
    const sendMessage = vi.fn()
    const transcribe = vi.fn().mockReturnValue(deferred.promise)
    const dialogue = useVoiceDialogue({ transcribe, sendMessage })

    const first = await dialogue.beginCapture()
    const pending = dialogue.transcribeAndSend(first.captureId, new Blob(['old']))
    const second = await dialogue.beginCapture()

    deferred.resolve({ text: 'stale transcript' })
    await pending

    expect(sendMessage).not.toHaveBeenCalled()
    expect(dialogue.activeCaptureId.value).toBe(second.captureId)
    expect(dialogue.status.value).toBe('capturing')
  })

  it('does not emit stale turn completion when active capture changes during send', async () => {
    const deferred = createDeferred<void>()
    const sendMessage = vi.fn().mockReturnValue(deferred.promise)
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const first = await dialogue.beginCapture()
    const pendingCommit = dialogue.commitTranscript(first.captureId, 'old')
    const firstTurnStarted = dialogue.events.value.find(
      (event: { type: string; captureId?: string; turnId?: string | null }) =>
        event.type === 'turn.started' && event.captureId === first.captureId,
    )
    expect(firstTurnStarted?.turnId).toBeTruthy()

    const second = await dialogue.beginCapture()

    deferred.resolve()
    await pendingCommit

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('old')
    expect(
      dialogue.events.value.some(
        event => event.type === 'turn.ended' && event.turnId === firstTurnStarted?.turnId,
      ),
    ).toBe(false)
    expect(dialogue.activeCaptureId.value).toBe(second.captureId)
    expect(dialogue.status.value).toBe('capturing')
  })

  it('suppresses stale transcribe rejections after a new capture begins', async () => {
    const deferred = createDeferred<{ text: string }>()
    const sendMessage = vi.fn()
    const transcribe = vi.fn().mockReturnValue(deferred.promise)
    const dialogue = useVoiceDialogue({ transcribe, sendMessage })

    const first = await dialogue.beginCapture()
    const pending = dialogue.transcribeAndSend(first.captureId, new Blob(['old']))
    const second = await dialogue.beginCapture()

    deferred.reject(new Error('transcribe failed'))

    await expect(pending).resolves.toBeUndefined()
    expect(dialogue.activeCaptureId.value).toBe(second.captureId)
    expect(dialogue.status.value).toBe('capturing')
    expect(dialogue.error.value).toBeNull()
    expect(
      dialogue.events.value.some(
        event => event.type === 'session.error' && event.captureId === first.captureId,
      ),
    ).toBe(false)
  })

  it('suppresses stale send rejections after a new capture begins', async () => {
    const deferred = createDeferred<void>()
    const sendMessage = vi.fn().mockReturnValue(deferred.promise)
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const first = await dialogue.beginCapture()
    const pending = dialogue.commitTranscript(first.captureId, 'hello')
    const firstTurnStarted = dialogue.events.value.find(
      (event: { type: string; captureId?: string; turnId?: string | null }) =>
        event.type === 'turn.started' && event.captureId === first.captureId,
    )
    expect(firstTurnStarted?.turnId).toBeTruthy()

    const second = await dialogue.beginCapture()

    deferred.reject(new Error('send failed'))

    await expect(pending).resolves.toBeUndefined()
    expect(dialogue.activeCaptureId.value).toBe(second.captureId)
    expect(dialogue.status.value).toBe('capturing')
    expect(dialogue.error.value).toBeNull()
    expect(
      dialogue.events.value.some(
        event => event.type === 'session.error' && event.captureId === first.captureId,
      ),
    ).toBe(false)
    expect(
      dialogue.events.value.some(
        event => event.type === 'turn.ended' && event.turnId === firstTurnStarted?.turnId,
      ),
    ).toBe(false)
  })

  it('emits capture.cancelled before starting a superseding capture', async () => {
    const dialogue = useVoiceDialogue({
      sendMessage: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const first = await dialogue.beginCapture()
    const second = await dialogue.beginCapture()
    const cancelledIndex = dialogue.events.value.findIndex(
      event => event.type === 'capture.cancelled' && event.captureId === first.captureId,
    )
    const startedIndex = dialogue.events.value.findIndex(
      event => event.type === 'capture.started' && event.captureId === second.captureId,
    )

    expect(cancelledIndex).toBeGreaterThan(-1)
    expect(startedIndex).toBeGreaterThan(-1)
    expect(cancelledIndex).toBeLessThan(startedIndex)
  })

  it('emits terminal cancellation events for an active turn before starting a superseding capture', async () => {
    const deferred = createDeferred<void>()
    const sendMessage = vi.fn().mockReturnValue(deferred.promise)
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const first = await dialogue.beginCapture()
    const pending = dialogue.commitTranscript(first.captureId, 'hello')
    const firstTurnStarted = dialogue.events.value.find(
      (event: { type: string; captureId?: string; turnId?: string | null }) =>
        event.type === 'turn.started' && event.captureId === first.captureId,
    )
    expect(firstTurnStarted?.turnId).toBeTruthy()

    const second = await dialogue.beginCapture()
    const turnCancelledIndex = dialogue.events.value.findIndex(
      event => event.type === 'turn.cancelled' && event.turnId === firstTurnStarted?.turnId,
    )
    const captureCancelledIndex = dialogue.events.value.findIndex(
      event => event.type === 'capture.cancelled' && event.captureId === first.captureId,
    )
    const secondStartedIndex = dialogue.events.value.findIndex(
      event => event.type === 'capture.started' && event.captureId === second.captureId,
    )

    expect(turnCancelledIndex).toBeGreaterThan(-1)
    expect(captureCancelledIndex).toBeGreaterThan(-1)
    expect(secondStartedIndex).toBeGreaterThan(-1)
    expect(turnCancelledIndex).toBeLessThan(secondStartedIndex)
    expect(captureCancelledIndex).toBeLessThan(secondStartedIndex)

    deferred.resolve()
    await pending

    expect(
      dialogue.events.value.some(
        event => event.type === 'turn.ended' && event.turnId === firstTurnStarted?.turnId,
      ),
    ).toBe(false)
  })

  it('empty transcript cancels capture and does not send', async () => {
    const sendMessage = vi.fn()
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: '' }),
    })

    const { captureId } = await dialogue.beginCapture()
    await dialogue.commitTranscript(captureId, '   \n  ')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(dialogue.activeCaptureId.value).toBeNull()
    expect(dialogue.status.value).toBe('idle')
    expect(dialogue.events.value.map(event => event.type)).toContain('capture.cancelled')
  })

  it('beginCapture calls stopOutputAudio for the barge-in boundary', async () => {
    const stopOutputAudio = vi.fn()
    const dialogue = useVoiceDialogue({
      sendMessage: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ text: '' }),
      stopOutputAudio,
    })

    await dialogue.beginCapture()

    expect(stopOutputAudio).toHaveBeenCalledOnce()
  })

  it('continues capture when stopOutputAudio rejects', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stopOutputAudio = vi.fn().mockRejectedValue(new Error('stop failed'))
    const dialogue = useVoiceDialogue({
      sendMessage: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({ text: '' }),
      stopOutputAudio,
    })

    const started = await dialogue.beginCapture()

    expect(stopOutputAudio).toHaveBeenCalledOnce()
    expect(started.captureId).toBeTruthy()
    expect(dialogue.status.value).toBe('capturing')
    expect(dialogue.activeCaptureId.value).toBe(started.captureId)
    expect(dialogue.error.value).toBeNull()
    expect(dialogue.events.value.at(-1)?.type).toBe('capture.started')
    expect(consoleWarn).toHaveBeenCalledWith('[useVoiceDialogue] Failed to stop output audio before capture:', expect.any(Error))
  })

  it('sets error state and emits session.error when sendMessage fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('send failed'))
    const dialogue = useVoiceDialogue({
      sendMessage,
      transcribe: vi.fn().mockResolvedValue({ text: 'ignored' }),
    })

    const { captureId } = await dialogue.beginCapture()

    await expect(dialogue.commitTranscript(captureId, 'hello')).rejects.toThrow('send failed')
    expect(dialogue.status.value).toBe('error')
    expect(dialogue.error.value?.message).toBe('send failed')
    expect(dialogue.events.value.at(-1)?.type).toBe('session.error')
  })
})
