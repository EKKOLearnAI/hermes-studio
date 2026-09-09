import type { Socket } from 'socket.io'
import { randomUUID } from 'crypto'
import { businessEvents, APP_BUSINESS_TYPES, type BusinessEvent } from './business-events'
import { stableChatWebhookEventId } from './envelope'
import { authenticateUserToken, type AuthenticatedUser } from '../../public/auth'
import { listUserProfiles } from '../../repositories/users-store'
import { getSession, getSessionNotificationPreview } from '../../repositories/session-store'
import { groupReplyNotification } from '../group-chat/foreground-notification'
import { foregroundNotification, foregroundNotificationAgent, foregroundNotificationPreview } from '../chat-run/foreground-notification'

interface Subscription { profile: string; types: string[]; sessionIds: string[]; roomIds: string[]; workflowIds: string[] }
interface GroupAccess { canReceive(user: AuthenticatedUser, roomId: string): boolean }
let groupAccess: GroupAccess | null = null
export function registerGroupEventAccess(access: GroupAccess): () => void {
  groupAccess = access
  return () => { if (groupAccess === access) groupAccess = null }
}
function allowed(user: AuthenticatedUser, profile: string): boolean {
  return user.role === 'super_admin' || listUserProfiles(user.id).some(item => item.profile_name === profile)
}
function ids(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 512)) throw new Error('invalid subscription filter')
  return value
}
export function parseAppSubscription(value: unknown): Subscription {
  const p = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (p.schema_version !== 1) throw new Error('unsupported event schema')
  const profile = typeof p.profile === 'string' ? p.profile.trim() || 'default' : 'default'
  const types = p.types === undefined ? [...APP_BUSINESS_TYPES] : ids(p.types)
  if (types.some(t => !(APP_BUSINESS_TYPES as readonly string[]).includes(t))) throw new Error('unsupported event type')
  return { profile, types, sessionIds: ids(p.session_ids), roomIds: ids(p.room_ids), workflowIds: ids(p.workflow_ids) }
}
export function appEventEnvelope(event: BusinessEvent) {
  if (event.type.startsWith('chat.')) {
    if (event.source === 'group_chat' || event.source === 'workflow') return null
    const name = event.type.replace('chat.clarification.', 'clarify.').replace(/^chat\./, '')
    const payload = { ...event.payload, session_id: event.subject.session_id }
    const notice = foregroundNotification(name, payload)
    if (!notice) return null
    const session = getSession(notice.sessionId)
    if (!session || (session.profile || 'default') !== event.profile || session.source === 'group_chat' || session.source === 'workflow') return null
    return { schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
      profile: event.profile, source: event.source, subject: event.subject,
      display: { ...foregroundNotificationPreview(notice.kind, getSessionNotificationPreview(notice.sessionId) || session, payload), agent: foregroundNotificationAgent(session.agent) } }
  }
  if (event.type === 'group.message.created') {
    const room = event.payload.room as {id:string;name:string}
    const message = event.payload.message as Parameters<typeof groupReplyNotification>[1]
    if (!room || !message) return null
    const notice = groupReplyNotification(room, message, Date.parse(event.occurred_at))
    if (!notice) return null
    const agents = Array.isArray(event.payload.agents) ? event.payload.agents as Array<Record<string, unknown>> : []
    const visible = agents.length > 4 ? agents.slice(0,3) : agents.slice(0,4)
    return { schema_version: 1, id:event.id,type:event.type,occurred_at:event.occurred_at,profile:event.profile,source:event.source,subject:event.subject,
      display: { title:notice.title,preview:notice.content,agentCount:agents.length,
        agents:visible.map(agent=>({id:String(agent.id || ''),name:String(agent.name || '').slice(0,80),agent:String(agent.agent || ''),avatar:typeof agent.avatar === 'string' && agent.avatar.length <= 65536 ? agent.avatar : ''})) } }
  }
  if (!(APP_BUSINESS_TYPES as readonly string[]).includes(event.type)) return null
  return { schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
    profile: event.profile, source: event.source, subject: event.subject, display: event.payload.display }
}
/** One subscription per authenticated socket; local/manual/cloud use the same command. */
export function bindAppEventSubscription(socket: Socket): void {
  let subscription: Subscription | null = null
  let revision = 0
  let closed = false
  let pending = 0
  let chain = Promise.resolve()
  const seen = new Set<string>()
  const token = String(socket.handshake.auth?.token || '')
  socket.on('app.events.subscribe', async (input: unknown, ack?: (result: unknown) => void) => {
    const ticket = ++revision
    subscription = null
    try {
      const request = parseAppSubscription(input)
      const user = await authenticateUserToken(token)
      if (!user || !allowed(user, request.profile)) throw new Error('Profile access denied')
      if (closed || ticket !== revision) return
      subscription = request
      socket.data.appEventVersion = 1
      ack?.({ ok: true, schema_version: 1 })
    } catch { if (!closed && ticket === revision) ack?.({ ok: false, error: 'event_subscription_denied' }) }
  })
  socket.on('app.events.unsubscribe', (_input: unknown, ack?: (result: unknown) => void) => {
    revision++; subscription = null; ack?.({ ok: true })
  })
  const stop = businessEvents.subscribe(`app:${socket.id}:${randomUUID()}`, event => {
    const request = subscription, ticket = revision
    if (closed || !request || !request.types.includes(event.type) || pending >= 100) return
    if (event.source !== 'group_chat' && request.profile !== event.profile) return
    const selected = event.subject.room_id ? request.roomIds : event.subject.workflow_id ? request.workflowIds : request.sessionIds
    const subjectId = event.subject.room_id || event.subject.workflow_id || event.subject.session_id || ''
    if (selected.length && !selected.includes(subjectId)) return
    pending++
    chain = chain.then(async () => {
      if (closed || revision !== ticket || subscription !== request || seen.has(event.id)) return
      // Revalidate JWT/account and current profile/membership on every delivery.
      const user = await authenticateUserToken(token)
      if (!user || !allowed(user, request.profile)) return
      if (event.source === 'group_chat' && (!event.subject.room_id || !groupAccess?.canReceive(user, event.subject.room_id))) return
      if (event.source !== 'group_chat' && !allowed(user, event.profile)) return
      const envelope = appEventEnvelope(event)
      if (!envelope || closed || revision !== ticket) return
      seen.add(event.id); if (seen.size > 2000) seen.delete(seen.values().next().value!)
      socket.emit('app.event', envelope)
    }).catch(() => {}).finally(() => { pending-- })
  })
  socket.on('disconnect', () => { closed = true; revision++; subscription = null; stop(); seen.clear() })
}
export function publishDomainEvent(type: 'group.message.created' | 'workflow.run.completed' | 'workflow.run.failed', profile: string,
  subject: BusinessEvent['subject'], display: Record<string, unknown>): void {
  const identity = type === 'group.message.created' ? `${subject.room_id}:${subject.message_id}` : `${subject.workflow_id}:${subject.run_id}`
  businessEvents.publish({ schema_version: 1, id: stableChatWebhookEventId(`${type}:${identity}`), type,
    occurred_at: new Date().toISOString(), profile: profile?.trim() || 'default', source: type.startsWith('group.') ? 'group_chat' : 'workflow', subject, payload: { display } })
}

export function publishGroupMessage(room: {id:string;name:string;summaryProfile:string}, message: Record<string, unknown>, agents: unknown[]): void {
  businessEvents.publish({schema_version:1,id:stableChatWebhookEventId(`group.message.created:${room.id}:${message.id}`),type:'group.message.created',occurred_at:new Date().toISOString(),profile:room.summaryProfile?.trim() || 'default',source:'group_chat',subject:{room_id:room.id,message_id:String(message.id)},payload:{room:{id:room.id,name:room.name},message,agents}})
}
