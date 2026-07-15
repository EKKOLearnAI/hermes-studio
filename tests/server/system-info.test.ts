import { arch, hostname, platform, release, type } from 'os'
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadSystemInfoWithInjectedVersion(version?: string, prepare?: (appHome: string) => void) {
  vi.resetModules()
  const appHome = mkdtempSync(join(tmpdir(), 'hermes-system-info-test-'))
  if (version === undefined) {
    delete (globalThis as any).__APP_VERSION__
  } else {
    ;(globalThis as any).__APP_VERSION__ = version
  }

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.15.2\n'),
  }))

  vi.doMock('../../packages/server/src/config', () => ({
    config: {
      appHome,
      port: 8648,
      host: '0.0.0.0',
      uploadDir: join(appHome, 'upload'),
      dataDir: join(appHome, 'data'),
      corsOrigins: '',
    },
  }))

  prepare?.(appHome)
  const mod = await import('../../packages/server/src/services/system-info')
  return { ...mod, appHome }
}

describe('public system info', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
  })

  it('returns host, os, Hermes Agent, and Web UI versions', async () => {
    const { getPublicDeviceTrustInfo, getPublicSystemInfo, appHome } = await loadSystemInfoWithInjectedVersion('9.9.9-test')

    try {
      const info = await getPublicSystemInfo()
      expect(info).toMatchObject({
        device_id: expect.any(String),
        device_public_key: expect.stringContaining('PUBLIC KEY'),
        computer_name: hostname(),
        os: {
          type: type(),
          platform: platform(),
          release: release(),
          arch: arch(),
        },
        hermes_agent_version: 'v0.15.2',
        hermes_web_ui_version: '9.9.9-test',
      })
      const trust = await getPublicDeviceTrustInfo()
      expect(trust).toMatchObject({
        device_id: info.device_id,
        device_public_key: info.device_public_key,
        device_exchange_public_key: expect.stringContaining('PUBLIC KEY'),
      })
      expect(JSON.stringify({ info, trust })).not.toMatch(/PRIVATE KEY|device_exchange_private_key/)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  it('upgrades a legacy signing identity without changing its stable device id', async () => {
    const signing = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const legacyId = `hwui_${createHash('sha256')
      .update(signing.publicKey).digest('base64url').slice(0, 32)}`
    const loaded = await loadSystemInfoWithInjectedVersion('9.9.9-test', appHome => {
      writeFileSync(join(appHome, 'device-identity.json'), JSON.stringify({
        device_id: legacyId,
        device_public_key: signing.publicKey,
        device_private_key: signing.privateKey,
      }), { mode: 0o600 })
    })

    try {
      const identity = await loaded.getDeviceIdentity()
      expect(identity).toMatchObject({
        device_id: legacyId,
        device_public_key: signing.publicKey,
        device_private_key: signing.privateKey,
        device_exchange_public_key: expect.stringContaining('PUBLIC KEY'),
        device_exchange_private_key: expect.stringContaining('PRIVATE KEY'),
      })
      const stored = JSON.parse(readFileSync(join(loaded.appHome, 'device-identity.json'), 'utf8'))
      expect(stored).toEqual(identity)

      const peer = generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      const localSecret = diffieHellman({
        privateKey: createPrivateKey(identity.device_exchange_private_key),
        publicKey: createPublicKey(peer.publicKey),
      })
      const peerSecret = diffieHellman({
        privateKey: createPrivateKey(peer.privateKey),
        publicKey: createPublicKey(identity.device_exchange_public_key),
      })
      expect(localSecret.equals(peerSecret)).toBe(true)
    } finally {
      rmSync(loaded.appHome, { recursive: true, force: true })
    }
  })

  it('serializes concurrent identity creation and persists owner-only key material', async () => {
    const { getDeviceIdentity, appHome } = await loadSystemInfoWithInjectedVersion('9.9.9-test')
    try {
      const identities = await Promise.all(Array.from({ length: 16 }, () => getDeviceIdentity()))
      expect(new Set(identities.map(identity => JSON.stringify(identity))).size).toBe(1)
      const identityPath = join(appHome, 'device-identity.json')
      expect(JSON.parse(readFileSync(identityPath, 'utf8'))).toEqual(identities[0])
      if (process.platform !== 'win32') expect(statSync(identityPath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  it('rejects signatures where the public key does not match the device id', async () => {
    const {
      appHome,
      createDeviceSigningPayload,
      deviceIdFromPublicKey,
      verifyDeviceSignature,
    } = await loadSystemInfoWithInjectedVersion('9.9.9-test')
    try {
      const first = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      const second = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      const timestamp = Date.now()
      const nonce = 'nonce-1'
      const deviceId = deviceIdFromPublicKey(first.publicKey)
      const signature = sign(null, Buffer.from(createDeviceSigningPayload({
        device_id: deviceId,
        nonce,
        timestamp,
      })), first.privateKey).toString('base64url')

      expect(verifyDeviceSignature({
        device_id: deviceId,
        device_public_key: first.publicKey,
        nonce,
        timestamp,
        signature,
      })).toBe(true)
      expect(verifyDeviceSignature({
        device_id: deviceId,
        device_public_key: second.publicKey,
        nonce,
        timestamp,
        signature,
      })).toBe(false)
      expect(verifyDeviceSignature({
        device_id: deviceId,
        device_public_key: first.publicKey.trim(),
        nonce,
        timestamp,
        signature,
      })).toBe(false)
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
