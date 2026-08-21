import { describe, expect, it } from 'vitest'
import { approvalAgentLabel, normalizeStudioApprovalChoices } from '../../packages/client/src/utils/runtime-approval'

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

  it.each([
    ['claude-code', ['deny'], ['deny']],
    ['pi', ['once'], ['once']],
    ['codex', ['session'], ['session']],
    ['ekko', ['always', 'deny'], ['always', 'deny']],
    ['hermes', ['always'], ['always']],
    ['unknown-runtime', ['session', 'deny'], ['deny']],
  ])('preserves only authoritative options supported by %s', (runtime, choices, expected) => {
    expect(normalizeStudioApprovalChoices(runtime, choices)).toEqual(expected)
  })
})
