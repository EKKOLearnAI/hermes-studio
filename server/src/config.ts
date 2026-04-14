import { resolve } from 'path'
import { tmpdir } from 'os'

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  upstream: process.env.UPSTREAM || 'http://127.0.0.1:8642',
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  uploadDir: process.env.UPLOAD_DIR || resolve(tmpdir(), 'hermes-uploads'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: process.env.CORS_ORIGINS || '*',
}
