export type VoiceDialogueEventType =
  | 'session.started'
  | 'session.closed'
  | 'session.error'
  | 'capture.started'
  | 'capture.stopped'
  | 'capture.cancelled'
  | 'transcript.delta'
  | 'transcript.done'
  | 'turn.started'
  | 'turn.ended'
  | 'turn.cancelled'
  | 'output.audio.started'
  | 'output.audio.done'
  | 'latency.metrics'

export interface VoiceDialogueEvent<TPayload = unknown> {
  id: string
  seq: number
  sessionId: string
  type: VoiceDialogueEventType
  captureId?: string
  turnId?: string
  timestamp: string
  final?: boolean
  payload?: TPayload
}

export interface CreateVoiceDialogueEventOptions<TPayload = unknown> {
  captureId?: string
  turnId?: string
  timestamp?: string
  final?: boolean
  payload?: TPayload
}

export function createVoiceEventSequencer(sessionId: string) {
  let seq = 0

  return function nextEvent<TPayload = unknown>(
    type: VoiceDialogueEventType,
    options: CreateVoiceDialogueEventOptions<TPayload> = {},
  ): VoiceDialogueEvent<TPayload> {
    seq += 1

    return {
      id: `${sessionId}:${seq}`,
      seq,
      sessionId,
      type,
      captureId: options.captureId,
      turnId: options.turnId,
      timestamp: options.timestamp ?? new Date().toISOString(),
      final: options.final,
      payload: options.payload,
    }
  }
}
