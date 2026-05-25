const PREVIEW_BASE_RE = /^\/preview\/([^/]+)(?:\/|$)/

export function resolveRouterBase(pathname: string = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  const previewMatch = pathname.match(PREVIEW_BASE_RE)
  if (previewMatch) {
    return `/preview/${previewMatch[1]}/`
  }

  return '/'
}
