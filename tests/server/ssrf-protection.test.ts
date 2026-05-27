import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { isSafeUrl } from '../../packages/server/src/lib/ssrf-protection'

describe('SSRF Protection', () => {
  describe('isPrivateOrReserved via isSafeUrl with direct IPs', () => {
    it('rejects loopback IPv4', async () => {
      expect(await isSafeUrl('http://127.0.0.1:6379')).toBe(false)
      expect(await isSafeUrl('http://127.0.0.2/test')).toBe(false)
    })

    it('rejects private Class A (10.x.x.x)', async () => {
      expect(await isSafeUrl('http://10.0.0.1')).toBe(false)
      expect(await isSafeUrl('http://10.255.255.255')).toBe(false)
    })

    it('rejects private Class C (192.168.x.x)', async () => {
      expect(await isSafeUrl('http://192.168.1.1')).toBe(false)
      expect(await isSafeUrl('http://192.168.0.254')).toBe(false)
    })

    it('rejects private Class B (172.16-31.x.x)', async () => {
      expect(await isSafeUrl('http://172.16.0.1')).toBe(false)
      expect(await isSafeUrl('http://172.31.255.255')).toBe(false)
    })

    it('rejects link-local (169.254.x.x)', async () => {
      expect(await isSafeUrl('http://169.254.169.254')).toBe(false)
    })

    it('rejects AWS metadata endpoint', async () => {
      expect(await isSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    })

    it('rejects 0.0.0.0', async () => {
      expect(await isSafeUrl('http://0.0.0.0:8080')).toBe(false)
    })

    it('rejects IPv6 loopback', async () => {
      expect(await isSafeUrl('http://[::1]:6379')).toBe(false)
    })

    it('rejects IPv6 unique-local (fc00::)', async () => {
      expect(await isSafeUrl('http://[fc00::1]')).toBe(false)
    })

    it('rejects IPv6 link-local (fe80::)', async () => {
      expect(await isSafeUrl('http://[fe80::1]')).toBe(false)
    })

    it('accepts public IPs', async () => {
      expect(await isSafeUrl('http://8.8.8.8')).toBe(true)
      expect(await isSafeUrl('http://1.1.1.1')).toBe(true)
      expect(await isSafeUrl('http://203.0.113.50')).toBe(true)
    })

    it('accepts 172.15.x.x and 172.32.x.x (outside private range)', async () => {
      expect(await isSafeUrl('http://172.15.0.1')).toBe(true)
      expect(await isSafeUrl('http://172.32.0.1')).toBe(true)
    })
  })

  describe('isSafeUrl with hostnames', () => {
    it('accepts public hostnames', async () => {
      expect(await isSafeUrl('https://api.openai.com/v1')).toBe(true)
      expect(await isSafeUrl('https://example.com')).toBe(true)
    })

    it('rejects localhost hostname', async () => {
      expect(await isSafeUrl('http://localhost:8080')).toBe(false)
    })

    it('rejects invalid URLs', async () => {
      expect(await isSafeUrl('not-a-url')).toBe(false)
      expect(await isSafeUrl('')).toBe(false)
    })
  })
})
