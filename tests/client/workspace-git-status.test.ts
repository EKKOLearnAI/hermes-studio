import { describe, expect, it } from 'vitest'
import { gitStatusBadge, gitStatusClass } from '@/utils/hermes/workspace-git-status'

describe('workspace git status presentation', () => {
  it('uses distinct VS Code-style badges for git operations', () => {
    expect(gitStatusBadge('modified')).toBe('M')
    expect(gitStatusBadge('untracked')).toBe('U')
    expect(gitStatusBadge('added')).toBe('A')
    expect(gitStatusBadge('deleted')).toBe('D')
    expect(gitStatusBadge('renamed')).toBe('R')
    expect(gitStatusBadge('conflicted')).toBe('!')
  })

  it('provides a status-specific class only when a decoration exists', () => {
    expect(gitStatusClass('modified')).toBe('git-status-modified')
    expect(gitStatusClass('untracked')).toBe('git-status-untracked')
    expect(gitStatusClass()).toBeUndefined()
  })
})
