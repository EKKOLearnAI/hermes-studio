import { generateKeyPairSync, sign } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  APP_ENTITLEMENT_AUDIENCE,
  APP_ENTITLEMENT_FEATURE,
  APP_ENTITLEMENT_ISSUER,
  APP_ENTITLEMENT_TOKEN_TYPE,
  inspectAppEntitlementToken,
  verifyAppEntitlementToken,
} from '../../packages/server/src/services/app-entitlement'

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const now = Date.UTC(2026, 7, 15, 8, 0, 0)
const nowSeconds = Math.floor(now / 1000)

function entitlementToken(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...headerOverrides })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: APP_ENTITLEMENT_ISSUER,
    aud: APP_ENTITLEMENT_AUDIENCE,
    sub: '7001',
    userId: 7001,
    tokenType: APP_ENTITLEMENT_TOKEN_TYPE,
    deviceCode: 'app_phone_001',
    features: [APP_ENTITLEMENT_FEATURE],
    plan: 'public_beta',
    iat: nowSeconds - 60,
    exp: nowSeconds + 72 * 60 * 60,
    jti: 'entitlement-token-001',
    ...overrides,
  })).toString('base64url')
  const unsigned = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), keyPair.privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

describe('App entitlement verification', () => {
  it('accepts a valid account-and-device-bound RS256 entitlement', () => {
    expect(verifyAppEntitlementToken(entitlementToken(), {
      publicKey: keyPair.publicKey,
      now,
    })).toEqual({
      issuer: APP_ENTITLEMENT_ISSUER,
      audience: 'ekko-studio',
      userId: 7001,
      deviceCode: 'app_phone_001',
      features: ['lan_access'],
      plan: 'public_beta',
      issuedAt: nowSeconds - 60,
      expiresAt: nowSeconds + 72 * 60 * 60,
      tokenId: 'entitlement-token-001',
    })
  })

  it('rejects the wrong audience, account identity, feature, algorithm, and expiry', () => {
    const options = { publicKey: keyPair.publicKey, now, clockToleranceSeconds: 0 }
    expect(verifyAppEntitlementToken(entitlementToken({ aud: 'hermes-studio-app-entitlement' }), options)).toBeNull()
    expect(verifyAppEntitlementToken(entitlementToken({ sub: '7002' }), options)).toBeNull()
    expect(verifyAppEntitlementToken(entitlementToken({ features: ['cloud_access'] }), options)).toBeNull()
    expect(verifyAppEntitlementToken(entitlementToken({}, { alg: 'HS256' }), options)).toBeNull()
    expect(verifyAppEntitlementToken(entitlementToken({ exp: nowSeconds }), options)).toBeNull()
  })

  it('rejects a token changed after it was signed', () => {
    const token = entitlementToken()
    const [header, body, signature] = token.split('.')
    const changedBody = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      userId: 9999,
      sub: '9999',
    })).toString('base64url')
    expect(verifyAppEntitlementToken(`${header}.${changedBody}.${signature}`, {
      publicKey: keyPair.publicKey,
      now,
    })).toBeNull()
  })

  it('keeps trusted plan and lifetime claims when a signed token has expired', () => {
    const token = entitlementToken({
      plan: 'paid',
      iat: nowSeconds,
      exp: nowSeconds,
    })

    expect(inspectAppEntitlementToken(token, {
      publicKey: keyPair.publicKey,
      now: now + 1_000,
      clockToleranceSeconds: 0,
    })).toEqual({
      status: 'expired',
      claims: {
        issuer: APP_ENTITLEMENT_ISSUER,
        audience: APP_ENTITLEMENT_AUDIENCE,
        userId: 7001,
        deviceCode: 'app_phone_001',
        features: [APP_ENTITLEMENT_FEATURE],
        plan: 'paid',
        issuedAt: nowSeconds,
        expiresAt: nowSeconds,
        tokenId: 'entitlement-token-001',
      },
    })
    expect(inspectAppEntitlementToken(token, {
      publicKey: keyPair.publicKey,
      now: now - 30_000,
    }).status).toBe('expired')
  })
})
