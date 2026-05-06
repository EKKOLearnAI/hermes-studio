import { resolve } from 'path'
import { homedir } from 'os'

export function getListenHost(env: Record<string, string | undefined> = process.env): string | undefined {
  const host = env.BIND_HOST?.trim()
  return host || undefined
}

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Leave host undefined by default so Node binds to IPv6 when available,
  // falling back to IPv4 on systems without IPv6 support.
  host: getListenHost(),
  upstream: process.env.UPSTREAM || 'http://127.0.0.1:8642',
  uploadDir: process.env.UPLOAD_DIR || resolve(homedir(), '.hermes-web-ui', 'upload'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: process.env.CORS_ORIGINS || '*',
  /** Session store: 'local' (self-built SQLite) or 'remote' (Hermes CLI) */
  sessionStore: (process.env.SESSION_STORE || 'local') as 'local' | 'remote',
}
