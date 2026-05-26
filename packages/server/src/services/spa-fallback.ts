const BLOCKED_PREFIXES = ['/api', '/health', '/upload', '/webhook', '/socket.io', '/v1']

export function shouldServeSpaFallback(pathname: string): boolean {
  if (!pathname) return false
  if (BLOCKED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false
  if (pathname !== '/' && /\.[a-zA-Z0-9]+$/.test(pathname)) return false
  return true
}
