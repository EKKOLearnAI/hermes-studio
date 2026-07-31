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
    expect(source).toContain('deltaSign: document.documentElement.dir === "rtl" ? 1 : -1')
    expect(source).toMatch(/\.chat-tool-resize-handle\s*\{[\s\S]*inset-inline-start: -7px;/)
  })

  it('mirrors group-chat and workflow resize seams without changing LTR sizing', () => {
    const groupSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const workflowSource = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

    expect(groupSource).toContain("deltaSign: document.documentElement.dir === 'rtl' ? 1 : -1")
    expect(groupSource).toMatch(/\.group-workspace-resize-handle\s*\{[\s\S]*inset-inline-start: -7px;/)
    expect(workflowSource).toContain("deltaSign: document.documentElement.dir === 'rtl' ? -1 : 1")
    expect(workflowSource).toMatch(/\.workflow-chat-resize-handle\s*\{[\s\S]*inset-inline-end: -7px;/)
  })

  it('mirrors fixed mobile panels only when the document is RTL', () => {
    const filesSource = readFileSync('packages/client/src/components/hermes/chat/FilesPanel.vue', 'utf8')
    const workflowSource = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

    expect(filesSource).toMatch(/\.files-tree-panel\s*\{[\s\S]*inset-inline-start: 0;[\s\S]*&:dir\(rtl\)\s*\{[\s\S]*translateX\(100%\)/)
    expect(workflowSource).toMatch(/\.workflow-runs-panel\s*\{[\s\S]*inset-inline-end: 0;[\s\S]*&:dir\(rtl\)\s*\{[\s\S]*box-shadow: 8px/)
  })

  it('keeps native Windows title-bar geometry LTR in every app language', () => {
    const source = readFileSync('packages/client/src/components/layout/DesktopTitleBar.vue', 'utf8')

    expect(source).toMatch(/\.desktop-titlebar\s*\{[\s\S]*direction: ltr;/)
  })

  it('renders the workspace, terminal, and desktop browser tabs as a full-height right icon rail', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-tabs" role="tablist"')
    expect(source).toContain(':aria-label="t(\'drawer.files\')"')
    expect(source).toContain(':aria-label="t(\'drawer.terminal\')"')
    expect(source).toContain(':aria-label="t(\'browser.title\')"')
    expect(source).toContain('v-if="desktopBrowserAvailable"')
    expect(source).toMatch(/\.chat-tool-panel-inner\s*\{[\s\S]*background: \$bg-main-surface;/)
    expect(source).toMatch(/\.chat-tool-tabs\s*\{[\s\S]*flex-direction: column;[\s\S]*order: 2;[\s\S]*height: 100%;[\s\S]*border-inline-start:/)
    expect(source).toMatch(/\.chat-tool-content\s*\{\s*order: 1;[\s\S]*background: \$bg-main-surface;/)
  })

  it('uses the drawer content surface for the conversation outline', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/OutlinePanel.vue', 'utf8')

    expect(source).toMatch(/\.outline-panel\s*\{[\s\S]*background-color: \$bg-main-surface;/)
  })

  it('keeps workspace diffs and their editor stretched across the drawer', () => {
    const source = readFileSync('packages/client/src/components/hermes/files/WorkspaceDiffPreview.vue', 'utf8')

    expect(source).toMatch(/\.workspace-diff-preview\s*\{[\s\S]*flex: 1;[\s\S]*width: 100%;[\s\S]*min-width: 0;/)
    expect(source).toMatch(/\.diff-preview-content\s*\{[\s\S]*min-width: 0;/)
    expect(source).toMatch(/:deep\(\.file-editor\)\s*\{[\s\S]*width: 100%;[\s\S]*min-width: 0;/)
  })
})
