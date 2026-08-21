export type StudioApprovalRuntime = 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi'
export type StudioApprovalChoice = 'once' | 'session' | 'always' | 'deny'

const CONSERVATIVE_APPROVAL_CHOICES: StudioApprovalChoice[] = ['once', 'deny']
const CODEX_APPROVAL_CHOICES: StudioApprovalChoice[] = ['once', 'session', 'deny']
const HERMES_APPROVAL_CHOICES: StudioApprovalChoice[] = ['once', 'session', 'always', 'deny']

function normalizeApprovalRuntime(runtime?: string): StudioApprovalRuntime | 'unknown' {
  switch (String(runtime || '').trim().toLowerCase()) {
    case 'claude':
    case 'claude_code':
    case 'claude-code':
      return 'claude-code'
    case 'codex':
      return 'codex'
    case 'pi':
      return 'pi'
    case 'ekko':
    case 'ekko-agent':
      return 'ekko'
    case 'bridge':
    case 'hermes':
      return 'hermes'
    default:
      return 'unknown'
  }
}

export function normalizeStudioApprovalChoices(runtime: string | undefined, choices: unknown): StudioApprovalChoice[] {
  const normalizedRuntime = normalizeApprovalRuntime(runtime)
  const supported = normalizedRuntime === 'codex'
    ? CODEX_APPROVAL_CHOICES
    : normalizedRuntime === 'hermes' || normalizedRuntime === 'ekko'
      ? HERMES_APPROVAL_CHOICES
      : CONSERVATIVE_APPROVAL_CHOICES
  const fallback = normalizedRuntime === 'codex'
    ? CODEX_APPROVAL_CHOICES
    : normalizedRuntime === 'hermes' || normalizedRuntime === 'ekko'
      ? CODEX_APPROVAL_CHOICES
      : CONSERVATIVE_APPROVAL_CHOICES
  const normalized = Array.isArray(choices)
    ? choices.filter((choice): choice is StudioApprovalChoice =>
        supported.includes(choice as StudioApprovalChoice))
    : []
  return normalized.length > 0 ? normalized : [...fallback]
}

export function approvalAgentLabel(runtime?: string, participantAgent?: string): string {
  const participant = String(participantAgent || '').trim()
  if (participant) {
    if (participant === 'ekko-agent') return 'Ekko'
    if (participant === 'claude-code') return 'Claude'
    if (participant === 'codex') return 'Codex'
    if (participant === 'pi') return 'Pi'
    if (participant === 'hermes') return 'Hermes Agent'
    return participant
  }
  switch (runtime) {
    case 'ekko': return 'Ekko'
    case 'claude-code': return 'Claude'
    case 'codex': return 'Codex'
    case 'pi': return 'Pi'
    default: return 'Hermes Agent'
  }
}
