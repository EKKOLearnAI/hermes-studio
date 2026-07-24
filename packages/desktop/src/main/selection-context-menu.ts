import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export function installSelectionContextMenu(targetWindow: BrowserWindow): void {
  targetWindow.webContents.on('context-menu', (_event, params) => {
    let template: MenuItemConstructorOptions[]

    if (params.isEditable) {
      template = [
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      ]
    } else if (params.selectionText && params.editFlags.canCopy) {
      template = [{ role: 'copy' }]
    } else {
      return
    }

    Menu.buildFromTemplate(template).popup({ window: targetWindow })
  })
}
