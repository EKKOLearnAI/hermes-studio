/** Payload deliberately excludes prompts, commands, credentials and message text. */
export function foregroundNotification(event: string, value: Record<string, unknown>, now = Date.now()) {
  const sessionId = typeof value.session_id === 'string' ? value.session_id : ''
  if (!sessionId || value.replayed === true || value.restored === true || value.background_snapshot === true) return null
  if (event.endsWith('.resolved') && (value.resolved === false || value.stale === true)) return null
  const requestKind = event.startsWith('approval.') ? 'approval' : event.startsWith('clarify.') ? 'clarify' : ''
  const id = requestKind ? value[`${requestKind}_id`] : value.run_id
  if (typeof id !== 'string' || !id) return null
  if (requestKind && (event.endsWith('.requested') || event.endsWith('.resolved'))) {
    return { id: `${sessionId}:${requestKind}:${id}`, sessionId, kind: 'approval', resolved: event.endsWith('.resolved'), timestamp: now }
  }
  if (!['run.completed', 'run.failed'].includes(event) || Number(value.queue_remaining || 0) > 0
    || value.interrupted === true || value.stop_reason === 'queue_insertion' || value.stop_reason === 'aborted') return null
  return { id: `${sessionId}:run:${id}`, sessionId, kind: event === 'run.failed' ? 'failure' : 'completion', resolved: false, timestamp: now }
}
