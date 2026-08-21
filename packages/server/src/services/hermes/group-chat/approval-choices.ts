export type GroupApprovalChoice = 'once' | 'session' | 'always' | 'deny'

const CONSERVATIVE_APPROVAL_CHOICES: GroupApprovalChoice[] = ['once', 'deny']
const CODEX_APPROVAL_CHOICES: GroupApprovalChoice[] = ['once', 'session', 'deny']
const HERMES_APPROVAL_CHOICES: GroupApprovalChoice[] = ['once', 'session', 'always', 'deny']

type ApprovalRuntime = 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'unknown'

function normalizeApprovalRuntime(runtime?: string): ApprovalRuntime {
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

export function normalizeGroupApprovalChoices(runtime: string | undefined, choices: unknown): GroupApprovalChoice[] {
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
        ? choices.filter((choice): choice is GroupApprovalChoice =>
            supported.includes(choice as GroupApprovalChoice))
        : []
    return normalized.length > 0 ? normalized : [...fallback]
}
