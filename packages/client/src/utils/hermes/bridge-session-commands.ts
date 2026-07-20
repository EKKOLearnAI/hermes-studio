export type BridgeSessionCommandName =
  | 'usage'
  | 'status'
  | 'abort'
  | 'queue'
  | 'skill'
  | 'bundles'
  | 'clear'
  | 'title'
  | 'compress'
  | 'fork'
  | 'steer'
  | 'destroy'
  | 'reload-mcp'
  | 'reload-skills'

export interface BridgeSessionCommandDefinition {
  key: string
  name: BridgeSessionCommandName
  descriptionKey: string
  argsKey?: string
  args?: string
  insertText?: string
  opensSkillPicker?: boolean
  opensBundlePicker?: boolean
  opensBundleCreator?: boolean
}

export const BRIDGE_SESSION_COMMAND_DEFINITIONS: BridgeSessionCommandDefinition[] = [
  { key: 'command:usage', name: 'usage', args: '', descriptionKey: 'chat.slashCommands.usage' },
  { key: 'command:status', name: 'status', args: '', descriptionKey: 'chat.slashCommands.status' },
  { key: 'command:abort', name: 'abort', args: '', descriptionKey: 'chat.slashCommands.abort' },
  { key: 'command:queue', name: 'queue', argsKey: 'chat.slashCommandArgs.message', descriptionKey: 'chat.slashCommands.queue' },
  { key: 'command:skill', name: 'skill', args: '', descriptionKey: 'skills.title', opensSkillPicker: true },
  { key: 'command:bundles', name: 'bundles', args: '', descriptionKey: 'chat.slashCommands.bundles', opensBundlePicker: true },
  { key: 'command:bundles-create', name: 'bundles', args: 'create', insertText: 'bundles create', descriptionKey: 'chat.slashCommands.bundlesCreate', opensBundleCreator: true },
  { key: 'command:clear', name: 'clear', args: '', descriptionKey: 'chat.slashCommands.clear' },
  { key: 'command:clear-history', name: 'clear', args: '--history', insertText: 'clear --history', descriptionKey: 'chat.slashCommands.clearHistory' },
  { key: 'command:title', name: 'title', argsKey: 'chat.slashCommandArgs.title', descriptionKey: 'chat.slashCommands.title' },
  { key: 'command:compress', name: 'compress', args: '', descriptionKey: 'chat.slashCommands.compress' },
  { key: 'command:fork', name: 'fork', argsKey: 'chat.slashCommandArgs.title', descriptionKey: 'chat.slashCommands.fork' },
  { key: 'command:steer', name: 'steer', argsKey: 'chat.slashCommandArgs.text', descriptionKey: 'chat.slashCommands.steer' },
  { key: 'command:destroy', name: 'destroy', args: '', descriptionKey: 'chat.slashCommands.destroy' },
  { key: 'command:reload-mcp', name: 'reload-mcp', args: '', descriptionKey: 'chat.slashCommands.reloadMcp' },
  { key: 'command:reload-skills', name: 'reload-skills', args: '', descriptionKey: 'chat.slashCommands.reloadSkills' },
]

export const BRIDGE_SESSION_COMMAND_NAMES = Array.from(
  new Set(BRIDGE_SESSION_COMMAND_DEFINITIONS.map(command => command.name)),
)

const BRIDGE_SESSION_COMMAND_ALIASES = new Map<string, BridgeSessionCommandName>([
  ['reload_skills', 'reload-skills'],
])

export function normalizeBridgeSessionCommandName(name: string): BridgeSessionCommandName | null {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  const alias = BRIDGE_SESSION_COMMAND_ALIASES.get(normalized)
  if (alias) return alias
  // Accept any valid-looking command name — the bridge/gateway handles
  // resolution for bundles and skill commands dynamically.
  if (/^[a-z][a-z0-9-]*$/.test(normalized)) {
    return normalized as BridgeSessionCommandName
  }
  return null
}

export function readBridgeSessionCommandName(input: string): BridgeSessionCommandName | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s|$)/)
  if (!match) return null
  return normalizeBridgeSessionCommandName(match[1])
}

export function isKnownBridgeSessionCommand(input: string): boolean {
  return readBridgeSessionCommandName(input) !== null
}
