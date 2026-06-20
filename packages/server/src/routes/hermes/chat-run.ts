import type { ChatRunSocket } from '../../services/hermes/run-chat'
import Router from '@koa/router'
import * as ctrl from '../../controllers/chat-run'

let chatRunServer: ChatRunSocket | null = null

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/chat-run/runs', ctrl.runOnce)

export function setChatRunServer(server: ChatRunSocket): void {
  chatRunServer = server
}

export function getChatRunServer(): ChatRunSocket | null {
  return chatRunServer
}
