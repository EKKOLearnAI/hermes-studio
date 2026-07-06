import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GroupChatPanel workspace save handling', () => {
  it('coerces null picker values before trimming so clearing the input saves an empty workspace', () => {
    const source = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(source).toContain("String(workspaceValue.value || '').trim()")
    expect(source).not.toContain('workspaceValue.value.trim()')
  })
})
