import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
}))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
  },
}))

import { installSelectionContextMenu } from '../../packages/desktop/src/main/selection-context-menu'

type ContextMenuHandler = (
  event: unknown,
  params: {
    selectionText: string
    isEditable: boolean
    editFlags: {
      canCut: boolean
      canCopy: boolean
      canPaste: boolean
      canSelectAll: boolean
    }
  },
) => void

function contextMenuParams({
  selectionText = '',
  isEditable = false,
  canCut = false,
  canCopy = false,
  canPaste = false,
  canSelectAll = false,
} = {}) {
  return {
    selectionText,
    isEditable,
    editFlags: { canCut, canCopy, canPaste, canSelectAll },
  }
}

function setupContextMenu() {
  let handler: ContextMenuHandler | undefined
  const webContents = {
    on: vi.fn((event: string, listener: ContextMenuHandler) => {
      if (event === 'context-menu') handler = listener
    }),
  }
  const targetWindow = { webContents }

  installSelectionContextMenu(targetWindow as never)

  return {
    handler: () => {
      expect(handler).toBeTypeOf('function')
      return handler!
    },
    targetWindow,
    webContents,
  }
}

describe('desktop selection context menu', () => {
  beforeEach(() => {
    electronMocks.buildFromTemplate.mockReset()
    electronMocks.popup.mockReset()
    electronMocks.buildFromTemplate.mockReturnValue({ popup: electronMocks.popup })
  })

  it('registers the selection menu on the main desktop window', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')

    expect(source).toContain("import { installSelectionContextMenu } from './selection-context-menu'")
    expect(source).toContain('installSelectionContextMenu(mainWindow)')
  })

  it('shows the native copy action for a copyable text selection', () => {
    const { handler, targetWindow, webContents } = setupContextMenu()

    expect(webContents.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    handler()({}, contextMenuParams({ selectionText: 'selected reply text', canCopy: true }))

    expect(electronMocks.buildFromTemplate).toHaveBeenCalledWith([{ role: 'copy' }])
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: targetWindow })
  })

  it('shows standard editing actions, including paste, in editable fields', () => {
    const { handler, targetWindow } = setupContextMenu()

    handler()({}, contextMenuParams({
      selectionText: 'draft text',
      isEditable: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    }))

    expect(electronMocks.buildFromTemplate).toHaveBeenCalledWith([
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: targetWindow })
  })

  it('does not replace existing context menus when there is no copyable selection', () => {
    const { handler } = setupContextMenu()

    handler()({}, contextMenuParams({ canCopy: true }))
    handler()({}, contextMenuParams({ selectionText: 'selected reply text' }))

    expect(electronMocks.buildFromTemplate).not.toHaveBeenCalled()
  })
})
