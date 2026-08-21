import { describe, expect, it } from 'vitest'
import { approvalAgentLabel } from '../../packages/client/src/utils/runtime-approval'

describe('Studio Runtime approval presentation', () => {
  it.each([
    ['hermes', '', 'Hermes Agent'],
    ['ekko', '', 'Ekko'],
    ['claude-code', '', 'Claude'],
    ['codex', '', 'Codex'],
    ['pi', '', 'Pi'],
    ['codex', 'Room reviewer', 'Room reviewer'],
  ])('labels %s approvals with their actual Agent owner', (runtime, participant, expected) => {
    expect(approvalAgentLabel(runtime, participant)).toBe(expected)
  })
})
