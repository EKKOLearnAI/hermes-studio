import { request } from '../client'

export interface SlashCommandEntry {
  name: string
  description: string
  type: 'bundle' | 'skill'
  command: string
}

export interface SlashCommandsResponse {
  bundles: SlashCommandEntry[]
}

export async function fetchSlashCommands(): Promise<SlashCommandsResponse> {
  return request<SlashCommandsResponse>('/api/hermes/slash-commands')
}
