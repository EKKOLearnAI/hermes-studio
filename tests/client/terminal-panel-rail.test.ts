import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('TerminalPanel compact session rail', () => {
  it('uses a headerless left rail for theme, sessions, deletion, and session creation', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/TerminalPanel.vue', 'utf8')

    expect(source).not.toContain('class="terminal-header"')
    expect(source).toContain('class="terminal-session-rail"')
    expect(source).toContain('{{ selectedThemeInitial }}')
    expect(source).toContain('@click="cycleTheme"')
    expect(source).toContain('v-for="session in sessions"')
    expect(source).toContain('class="terminal-session-delete"')
    expect(source).toContain('@click="createSession"')
    expect(source).toMatch(/\.terminal-session-rail\s*\{[\s\S]*width: 48px;/)
    expect(source).toMatch(/\.terminal-session-slot\s*\{[\s\S]*&:hover \.terminal-session-delete/)
    expect(source).toMatch(/\.terminal-session-delete\s*\{[\s\S]*top: 1px;[\s\S]*right: 1px;/)
  })

  it('fills the terminal main area without an outer margin, border, or radius', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/TerminalPanel.vue', 'utf8')

    expect(source).toMatch(/\.terminal-container\s*\{[\s\S]*margin: 0;/)
    expect(source).toMatch(/\.terminal-xterm\s*\{[\s\S]*border-radius: 0;[\s\S]*border: 0;/)
  })

  it('keeps the files drawer on the same themed background as the tool content', () => {
    const filesSource = readFileSync('packages/client/src/components/hermes/chat/FilesPanel.vue', 'utf8')

    expect(filesSource).toMatch(/\.files-panel-drawer\s*\{[\s\S]*background: inherit;/)
    expect(filesSource).toMatch(/\.files-tree-panel\s*\{[\s\S]*background: inherit;/)
    expect(filesSource).toMatch(/\.files-main-panel\s*\{[\s\S]*background: inherit;/)
  })
})
