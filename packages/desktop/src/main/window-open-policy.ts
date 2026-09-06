export function isTrustedDesktopAppUrl(url: string, webUiUrl: string | null | undefined): boolean {
  if (!webUiUrl) return false
  try {
    const candidate = new URL(url)
    const webUi = new URL(webUiUrl)
    if (webUi.protocol !== 'http:' && webUi.protocol !== 'https:') return false
    if (candidate.protocol !== webUi.protocol) return false
    return candidate.origin === webUi.origin
  } catch {
    return false
  }
}
