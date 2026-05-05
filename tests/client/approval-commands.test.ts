import { describe, expect, it } from 'vitest'
import { isApprovalCommand, parseApprovalCommand } from '../../packages/client/src/utils/approval-commands'

describe('approval command parsing', () => {
  it('maps slash commands to the upstream run approval choices', () => {
    expect(parseApprovalCommand('/approve')).toEqual({ choice: 'once', all: false })
    expect(parseApprovalCommand('/approve session')).toEqual({ choice: 'session', all: false })
    expect(parseApprovalCommand('/approve always')).toEqual({ choice: 'always', all: false })
    expect(parseApprovalCommand('/deny')).toEqual({ choice: 'deny', all: false })
  })

  it('keeps all as resolve-all, not as always allow', () => {
    expect(parseApprovalCommand('  /approve all  ')).toEqual({ choice: 'once', all: true })
    expect(parseApprovalCommand('/DENY ALL')).toEqual({ choice: 'deny', all: true })
  })

  it('rejects ordinary chat text and malformed approval-like commands', () => {
    expect(parseApprovalCommand('approve')).toBeNull()
    expect(parseApprovalCommand('/approve please')).toBeNull()
    expect(parseApprovalCommand('/deny session')).toBeNull()
    expect(parseApprovalCommand('/always')).toBeNull()
    expect(isApprovalCommand('hello')).toBe(false)
  })
})
