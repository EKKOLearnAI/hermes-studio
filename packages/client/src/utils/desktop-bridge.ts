export interface DesktopWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopPetWindowState {
  bounds: DesktopWindowBounds
  visible: boolean
}

export interface HermesDesktopBridge {
  getToken: () => Promise<string>
  ensureAuth?: () => Promise<boolean>
  retryBootstrap: (source?: 'cf' | 'github') => Promise<void>
  selectRuntimeDirectory?: (defaultPath?: string) => Promise<string | null>
  notifyCompletion: (payload: { title: string; body?: string; icon?: string; tag?: string }) => Promise<boolean>
  getWindowState: () => Promise<{ isMaximized: boolean }>
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
  onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
  getPetWindowState?: () => Promise<DesktopPetWindowState>
  setPetWindowBounds?: (bounds: DesktopWindowBounds) => Promise<DesktopPetWindowState>
  setPetWindowVisible?: (visible: boolean) => Promise<DesktopPetWindowState>
  onPetWindowRefresh?: (callback: () => void) => () => void
  platform: string
  isDesktop: boolean
  windowKind?: 'main' | 'pet'
}

export type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

export function desktopBridge(): HermesDesktopBridge | undefined {
  return (window as WindowWithHermesDesktop).hermesDesktop
}

export function isDesktopShell(): boolean {
  return desktopBridge()?.isDesktop === true
}

export function isDesktopPetWindow(): boolean {
  return desktopBridge()?.windowKind === 'pet'
}
