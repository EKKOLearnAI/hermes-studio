import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('Android companion OpenAPI', () => {
  it('publishes twelve authenticated operations and marks trust mutations as super-admin only', async () => {
    const document = await loadDocument()
    const paths = {
      '/api/hermes/android-companion/overview': ['get'],
      '/api/hermes/android-companion/pairing/offers': ['post'],
      '/api/hermes/android-companion/pairing/offers/{challengeId}': ['delete'],
      '/api/hermes/android-companion/pairing/complete': ['post'],
      '/api/hermes/android-companion/devices': ['get'],
      '/api/hermes/android-companion/devices/{deviceId}/revoke': ['post'],
      '/api/hermes/android-companion/capabilities': ['get'],
      '/api/hermes/android-companion/commands': ['get'],
      '/api/hermes/android-companion/receipts': ['get'],
      '/api/hermes/android-companion/notifications': ['get'],
      '/api/hermes/android-companion/artifacts': ['get'],
      '/api/hermes/android-companion/takeovers': ['get'],
    } as const
    const operations = Object.entries(paths)
      .flatMap(([path, methods]) => methods.map(method => document.paths[path]?.[method]))
    expect(operations).toHaveLength(12)
    expect(operations.every(operation => operation?.tags?.[0] === 'Android Companion')).toBe(true)
    expect(operations.every(operation => Array.isArray(operation?.security?.[0]?.BearerAuth))).toBe(true)

    for (const [path, method] of [
      ['/api/hermes/android-companion/pairing/offers', 'post'],
      ['/api/hermes/android-companion/pairing/offers/{challengeId}', 'delete'],
      ['/api/hermes/android-companion/pairing/complete', 'post'],
      ['/api/hermes/android-companion/devices/{deviceId}/revoke', 'post'],
    ]) expect(document.paths[path][method]['x-hermes-required-role']).toBe('super_admin')
  })

  it('uses strict pairing and revocation bodies with explicit local approval', async () => {
    const document = await loadDocument()
    const pairing = document.paths['/api/hermes/android-companion/pairing/complete'].post
      .requestBody.content['application/json'].schema
    expect(pairing).toMatchObject({
      additionalProperties: false,
      required: ['challengeId', 'code', 'signedTranscript', 'approved'],
    })
    expect(pairing.properties.approved).toMatchObject({ type: 'boolean', enum: [true] })
    expect(pairing.properties.signedTranscript.additionalProperties).toBe(false)
    expect(pairing.properties.signedTranscript.properties.transcript.additionalProperties).toBe(false)
    expect(pairing.properties.signedTranscript.properties.transcript.properties.companion.additionalProperties)
      .toBe(false)

    const revoke = document.paths['/api/hermes/android-companion/devices/{deviceId}/revoke'].post
      .requestBody.content['application/json'].schema
    expect(revoke).toMatchObject({ additionalProperties: false, required: ['expectedVersion', 'reason'] })
    expect(revoke.properties.reason.pattern).toBe('^[A-Z][A-Z0-9_]{1,127}$')
    expect(document.paths['/api/hermes/android-companion/pairing/offers'].post.responses['201']).toBeTruthy()
    expect(document.paths['/api/hermes/android-companion/pairing/complete'].post.responses['201']).toBeTruthy()
  })

  it('keeps control-plane DTOs bounded and free of device trust and execution secrets', async () => {
    const document = await loadDocument()
    const names = [
      'AndroidOverviewResponse', 'AndroidDeviceDto', 'AndroidCapabilityDto', 'AndroidCommandDto',
      'AndroidReceiptDto', 'AndroidNotificationDto', 'AndroidArtifactDto', 'AndroidTakeoverDto',
    ]
    for (const name of names) {
      const encoded = JSON.stringify(document.components.schemas[name])
      expect(encoded).not.toMatch(/installationId|PrivateKey|sessionKey|executionToken|materialDigest|deliverySequence/i)
      expect(encoded).not.toMatch(/notificationKeyHash|channelHash|provenanceDigest|encryptionContextDigest|claimDigest/i)
      expect(encoded).not.toMatch(/encryptedRef|ciphertext|rawPayload|rawTarget|verificationEvidence/i)
    }
    expect(document.components.schemas.AndroidCommandDto.properties).not.toHaveProperty('payload')
    expect(document.components.schemas.AndroidCommandDto.properties).not.toHaveProperty('response')
    expect(document.components.schemas.AndroidReceiptDto.properties).not.toHaveProperty('target')
    expect(document.components.schemas.AndroidReceiptDto.properties).not.toHaveProperty('verification')
    expect(document.components.schemas.AndroidNotificationDto.properties).not.toHaveProperty('sourceSequence')
    expect(document.components.schemas.AndroidArtifactDto.properties).not.toHaveProperty('encryptionContext')
    expect(document.components.schemas.AndroidTakeoverDto.properties).not.toHaveProperty('claim')
    expect(document.components.schemas.AndroidCommandListResponse.properties.commands.maxItems).toBe(200)
  })

  it('regenerates deterministically', () => {
    const before = readFileSync('docs/openapi.json', 'utf8')
    const generated = spawnSync(process.execPath, ['scripts/generate-openapi.mjs'], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    expect(readFileSync('docs/openapi.json', 'utf8')).toBe(before)
  }, 15_000)
})

async function loadDocument(): Promise<any> {
  const ctx: any = { set: () => undefined, body: null }
  await openapi(ctx)
  return ctx.body
}
