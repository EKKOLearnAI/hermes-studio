const PREVIEW_BASE_RE = /^\/preview(?:\/|$)/

export function resolveRouterBase(pathname: string = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  if (PREVIEW_BASE_RE.test(pathname)) {
    return '/preview/'
  }

  return '/'
}
