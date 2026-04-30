import type { ChatRunSocket } from '../../services/hermes/chat-run-socket'

let chatRunServer: ChatRunSocket | null = null

export function setChatRunServer(server: ChatRunSocket): void {
  chatRunServer = server
}

export function getChatRunServer(): ChatRunSocket | null {
  return chatRunServer
}
