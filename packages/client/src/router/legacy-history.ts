export function resolveLegacyHashRoute(hash: string, currentSearch = ''): { path: string; query: Record<string, string> } | null {
  if (!hash.startsWith('#/')) return null

  const legacyUrl = new URL(hash.slice(1), window.location.origin)
  if (!legacyUrl.pathname || legacyUrl.pathname === '/') return null

  const query: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(currentSearch).entries()) {
    query[key] = value
  }
  for (const [key, value] of legacyUrl.searchParams.entries()) {
    query[key] = value
  }

  return {
    path: legacyUrl.pathname,
    query,
  }
}
