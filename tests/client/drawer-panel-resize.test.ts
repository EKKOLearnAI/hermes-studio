import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel tool drawer resizing support', () => {
  it('persists and clamps the live chat tool panel width while keeping mobile full width', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-panel"')
    expect(source).toContain('const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth"')
    expect(source).toContain('function clampToolPanelWidth')
    expect(source).toContain('Math.floor(available * 0.88)')
    expect(source).toContain('window.localStorage.setItem(TOOL_PANEL_STORAGE_KEY')
    expect(source).toContain('window.addEventListener("resize", handleToolPanelViewportResize)')
    expect(source).toContain('watch(showToolPanel')
    expect(source).toContain('width: 100% !important;')
  })

  it('renders the workspace, terminal, and desktop browser tabs as a full-height right icon rail', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-tabs" role="tablist"')
    expect(source).toContain(':aria-label="t(\'drawer.files\')"')
    expect(source).toContain(':aria-label="t(\'drawer.terminal\')"')
    expect(source).toContain(':aria-label="t(\'browser.title\')"')
    expect(source).toContain('v-if="desktopBrowserAvailable"')
    expect(source).toMatch(/\.chat-tool-panel-inner\s*\{[\s\S]*background: \$bg-main-surface;/)
    expect(source).toMatch(/\.chat-tool-tabs\s*\{[\s\S]*flex-direction: column;[\s\S]*order: 2;[\s\S]*height: 100%;[\s\S]*border-left:/)
    expect(source).toMatch(/\.chat-tool-content\s*\{\s*order: 1;[\s\S]*background: \$bg-main-surface;/)
  })

  it('uses the drawer content surface for the conversation outline', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/OutlinePanel.vue', 'utf8')

    expect(source).toMatch(/\.outline-panel\s*\{[\s\S]*background-color: \$bg-main-surface;/)
  })
})
