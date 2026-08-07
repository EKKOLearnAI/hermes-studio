import type { Server, Socket } from 'socket.io'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../middleware/user-auth'
import { userCanAccessProfile } from '../db/hermes/users-store'
import { notificationService } from './notification-service'
import { logger } from './logger'

const NAMESPACE = '/notifications'

export function notificationRoom(ownerId: number, profile: string): string {
  return `notification:${ownerId}:${profile}`
}

export class NotificationSocketServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly removeListener: () => void

  constructor(io: Server) {
    this.nsp = io.of(NAMESPACE)
    this.removeListener = notificationService.onCreated(event => {
      this.nsp.to(notificationRoom(event.ownerId, event.profile)).emit('notification.created', event.notification)
    })
  }

  init() {
    this.nsp.use(this.authenticate.bind(this))
    this.nsp.on('connection', socket => {
      const user = socket.data.user as AuthenticatedUser
      const profile = String(socket.handshake.query.profile || '').trim()
      void socket.join(notificationRoom(user.id, profile))
    })
    logger.info('[notification-socket] Socket.IO ready at %s', NAMESPACE)
  }

  close() { this.removeListener() }

  private async authenticate(socket: Socket, next: (error?: Error) => void) {
    if (!await isAuthEnabled()) return next(new Error('Authentication required'))
    const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
    const profile = String(socket.handshake.query.profile || '').trim()
    if (!user || !profile) return next(new Error('Authentication failed'))
    if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile)) {
      return next(new Error('Profile access denied'))
    }
    socket.data.user = user
    next()
  }
}
