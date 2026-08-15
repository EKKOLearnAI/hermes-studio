import type { ChatRunSocket } from './index'

let chatRunServer: ChatRunSocket | null = null

export function setChatRunServer(server: ChatRunSocket | null): void {
  chatRunServer = server
}

export function getChatRunServer(): ChatRunSocket | null {
  return chatRunServer
}
