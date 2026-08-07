import { io, type Socket } from 'socket.io-client'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'
import type { NotificationRecord } from './notifications'

let socket: Socket | null = null
let profile: string | null = null

export function connectNotificationSocket(): Socket {
  const activeProfile = getActiveProfileName() || 'default'
  if (socket && profile === activeProfile) return socket
  socket?.disconnect()
  profile = activeProfile
  socket = io(`${getBaseUrlValue()}/notifications`, {
    auth: { token: getApiKey() },
    query: { profile: activeProfile },
    transports: ['websocket', 'polling'],
    reconnection: true,
  })
  return socket
}

export function onNotificationCreated(handler: (notification: NotificationRecord) => void): () => void {
  const active = connectNotificationSocket()
  active.on('notification.created', handler)
  return () => active.off('notification.created', handler)
}

export function disconnectNotificationSocket() {
  socket?.disconnect()
  socket = null
  profile = null
}
