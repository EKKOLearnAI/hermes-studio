import { desktopBridge, hasDesktopBrowserBridge } from './desktop-bridge'

export const OPEN_DESKTOP_BROWSER_PANEL_EVENT = 'hermes:open-desktop-browser-panel'

function revealDesktopBrowserPanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DESKTOP_BROWSER_PANEL_EVENT))
}

export async function openUrlInDesktopBrowser(url: string): Promise<boolean> {
  if (!hasDesktopBrowserBridge()) return false
  const browser = desktopBridge()?.browser
  if (!browser) return false
  await browser.createTab(url, true)
  revealDesktopBrowserPanel()
  return true
}

export async function openHtmlInDesktopBrowser(html: string, title: string): Promise<boolean> {
  if (!hasDesktopBrowserBridge()) return false
  const browser = desktopBridge()?.browser
  if (!browser?.createHtmlPreviewTab) return false
  await browser.createHtmlPreviewTab(html, title, true)
  revealDesktopBrowserPanel()
  return true
}
