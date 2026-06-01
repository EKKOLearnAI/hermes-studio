export type SecurityLevel = 'L1_Passive' | 'L2_ReadOnly' | 'L3_Sensitive' | 'L4_Locked'

export interface ApprovalGatewayDecision {
  tool: string
  securityLevel: SecurityLevel
  locked: boolean
}

export const SHOW_APPROVAL_MODAL_EVENT = 'SHOW_APPROVAL_MODAL'
export const L4_LOCKED_TERMINAL_DESCRIPTION = 'ApprovalGateway L4_Locked: terminal/bash execution requires explicit approval.'
export const TOOL_EXECUTION_REJECTED_MESSAGE = 'System: Tool execution rejected by user.'

const L4_LOCKED_TOOLS = new Set(['terminal', 'bash'])

export class ApprovalGateway {
  classifyTool(toolName: unknown): ApprovalGatewayDecision {
    const tool = String(toolName || '').trim().toLowerCase()
    const locked = L4_LOCKED_TOOLS.has(tool)
    return {
      tool: tool || 'unknown',
      securityLevel: locked ? 'L4_Locked' : 'L3_Sensitive',
      locked,
    }
  }

  formatCommandArguments(args: unknown): string {
    if (typeof args === 'string') {
      const trimmed = args.trim()
      if (!trimmed) return ''
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
          return parsed.command
        }
        return JSON.stringify(parsed, null, 2)
      } catch {
        return trimmed
      }
    }
    if (args && typeof args === 'object') {
      const command = (args as { command?: unknown }).command
      if (typeof command === 'string') return command
      return JSON.stringify(args, null, 2)
    }
    return String(args || '')
  }
}

export const approvalGateway = new ApprovalGateway()
