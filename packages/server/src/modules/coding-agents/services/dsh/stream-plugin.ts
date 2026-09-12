export const DSH_STREAM_METHOD = '_ekko/assistant_stream'

/** Loaded only in Studio's private ACP profile, never in the user's DSH install. */
export const DSH_STREAM_PLUGIN = `
export const name = 'ekko-studio-assistant-stream'
export function apply(ctx) {
  const attempts = new WeakMap()
  const notify = (session, frame) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: '${DSH_STREAM_METHOD}',
    params: { sessionId: session.header.id, frame },
  }) + '\\n')
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    if (frame.type === 'start') {
      attempts.set(session, frame.attemptId)
      notify(session, { type: 'start', attemptId: frame.attemptId })
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        notify(session, { type: chunk.type, attemptId: frame.attemptId, text: chunk.text })
      }
    } else if (frame.type === 'end') {
      attempts.delete(session)
      notify(session, { type: 'end', attemptId: frame.attemptId })
    }
  })
  // DSH queues ACP projections asynchronously after this synchronous durable event.
  // Link the live attempt to the ACP message ID before its final blocks arrive.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const attemptId = attempts.get(session)
    if (attemptId) notify(session, { type: 'commit', attemptId, messageId: event.data.message.id })
  })
}
`
