const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shellLauncher', {
  getConfig: () => ipcRenderer.invoke('shell-launcher-get-config'),
  saveConfig: (payload) => ipcRenderer.invoke('shell-launcher-save-config', payload),
  getI18n: () => ipcRenderer.invoke('shell-get-i18n'),
  setLocale: (locale) => ipcRenderer.invoke('shell-set-locale', locale),
  checkHealth: (payload) => ipcRenderer.invoke('shell-launcher-check-health', payload),
  startServer: (payload) => ipcRenderer.invoke('shell-start-server', payload),
  stopServer: () => ipcRenderer.invoke('shell-stop-server'),
  openMainWindow: (payload) => ipcRenderer.invoke('shell-launcher-open-main', payload),
  onLog: (callback) => {
    const handler = (_e, data) => callback(data)
    ipcRenderer.on('launcher-log', handler)
    return () => ipcRenderer.removeListener('launcher-log', handler)
  },
  onServerReady: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('launcher-server-ready', handler)
    return () => ipcRenderer.removeListener('launcher-server-ready', handler)
  },
  onDetectedUrl: (callback) => {
    const handler = (_e, url) => callback(url)
    ipcRenderer.on('launcher-detected-url', handler)
    return () => ipcRenderer.removeListener('launcher-detected-url', handler)
  },
  onServerFailed: (callback) => {
    const handler = (_e, msg) => callback(msg)
    ipcRenderer.on('launcher-server-failed', handler)
    return () => ipcRenderer.removeListener('launcher-server-failed', handler)
  },
  onModeChanged: (callback) => {
    const handler = (_e, mode) => callback(mode)
    ipcRenderer.on('launcher-mode-changed', handler)
    return () => ipcRenderer.removeListener('launcher-mode-changed', handler)
  },
})
