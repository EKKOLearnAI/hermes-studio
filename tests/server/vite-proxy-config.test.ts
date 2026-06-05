import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('vite proxy config', () => {
  it('strips browser origin headers from proxied http and websocket requests', () => {
    const source = readFileSync('vite.config.ts', 'utf8')

    expect(source).toContain("proxy.on('proxyReq'")
    expect(source).toContain("proxy.on('proxyReqWs'")

    const httpProxyBlock = source.match(/proxy\.on\('proxyReq'[\s\S]*?\n\s*\}\)/)?.[0] || ''
    const wsProxyBlock = source.match(/proxy\.on\('proxyReqWs'[\s\S]*?\n\s*\}\)/)?.[0] || ''

    for (const block of [httpProxyBlock, wsProxyBlock]) {
      expect(block).toContain("removeHeader('origin')")
      expect(block).toContain("removeHeader('referer')")
    }
  })
})
