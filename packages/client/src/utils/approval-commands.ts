export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface ApprovalCommand {
  choice: ApprovalChoice
  all: boolean
}

const APPROVAL_COMMAND_RE = /^\/(approve|deny)(?:\s+(session|always|all))?\s*$/i

export function parseApprovalCommand(input: string): ApprovalCommand | null {
  const match = input.trim().match(APPROVAL_COMMAND_RE)
  if (!match) return null

  const verb = match[1].toLowerCase()
  const modifier = match[2]?.toLowerCase()

  if (verb === 'deny') {
    if (modifier && modifier !== 'all') return null
    return { choice: 'deny', all: modifier === 'all' }
  }

  if (modifier === 'session') return { choice: 'session', all: false }
  if (modifier === 'always') return { choice: 'always', all: false }
  return { choice: 'once', all: modifier === 'all' }
}

export function isApprovalCommand(input: string): boolean {
  return parseApprovalCommand(input) != null
}
