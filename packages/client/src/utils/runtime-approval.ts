export type StudioApprovalRuntime = 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi'

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
