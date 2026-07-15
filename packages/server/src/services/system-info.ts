import { arch, hostname, platform, release, type } from 'os'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { config } from '../config'
import * as hermesCli from './hermes/hermes-cli'

declare const __APP_VERSION__: string

type PackageInfo = {
  version: string
}

export type PublicSystemInfo = {
  device_id: string
  device_public_key: string
  computer_name: string
  os: {
    type: string
    platform: NodeJS.Platform
    release: string
    arch: string
  }
  hermes_agent_version: string
  hermes_web_ui_version: string
}

export type DeviceIdentity = {
  device_id: string
  device_public_key: string
  device_private_key: string
  device_exchange_public_key: string
  device_exchange_private_key: string
}

export type PublicDeviceTrustInfo = {
  device_id: string
  device_public_key: string
  device_exchange_public_key: string
}

const DEVICE_IDENTITY_PATH = resolve(config.appHome, 'device-identity.json')

let identityPromise: Promise<DeviceIdentity> | null = null

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    // ts-node dev: packages/server/src/services -> repo root
    resolve(__dirname, '../../../../package.json'),
    // bundled server: dist/server -> repo root/package root
    resolve(__dirname, '../../package.json'),
    // fallback for dev/test processes started at the repo root
    resolve(process.cwd(), 'package.json'),
  ]

  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue

    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (pkg?.version) return { version: String(pkg.version) }
    } catch {
      // Try the next candidate path.
    }
  }

  return null
}

export function getHermesWebUiVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : readPackageInfo()?.version || ''
}

export function normalizeHermesAgentVersion(raw: string): string {
  return raw.split('\n')[0]?.replace(/^Hermes Agent\s+/, '').trim() || ''
}

type SigningIdentity = Pick<DeviceIdentity, 'device_id' | 'device_public_key' | 'device_private_key'>

function isValidSigningIdentity(value: any): value is SigningIdentity {
  return typeof value?.device_id === 'string'
    && typeof value?.device_public_key === 'string'
    && typeof value?.device_private_key === 'string'
    && deviceIdFromPublicKey(value.device_public_key) === value.device_id
    && isValidKeyPair(value.device_public_key, value.device_private_key, 'ed25519')
}

function isValidDeviceIdentity(value: any): value is DeviceIdentity {
  if (!isValidSigningIdentity(value)) return false
  const candidate = value as SigningIdentity & Partial<DeviceIdentity>
  return typeof candidate.device_exchange_public_key === 'string'
    && typeof candidate.device_exchange_private_key === 'string'
    && isValidKeyPair(candidate.device_exchange_public_key, candidate.device_exchange_private_key, 'x25519')
}

function isValidKeyPair(publicKey: string, privateKey: string, type: 'ed25519' | 'x25519'): boolean {
  try {
    const publicObject = createPublicKey(publicKey)
    const privateObject = createPrivateKey(privateKey)
    if (publicObject.asymmetricKeyType !== type || privateObject.asymmetricKeyType !== type) return false
    const normalizedPublic = publicObject.export({ type: 'spki', format: 'pem' }).toString()
    const derivedPublic = createPublicKey(privateObject).export({ type: 'spki', format: 'pem' }).toString()
    return normalizedPublic === derivedPublic
  } catch {
    return false
  }
}

export function deviceIdFromPublicKey(publicKey: string): string {
  return `hwui_${createHash('sha256').update(publicKey).digest('base64url').slice(0, 32)}`
}

async function readOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  let existing: unknown = null
  try {
    existing = JSON.parse(await readFile(DEVICE_IDENTITY_PATH, 'utf-8'))
  } catch {
    // Create a fresh identity below.
  }
  if (isValidDeviceIdentity(existing)) {
    await chmod(DEVICE_IDENTITY_PATH, 0o600)
    return existing
  }

  let deviceId: string
  let signingPublicKey: string
  let signingPrivateKey: string
  if (isValidSigningIdentity(existing)) {
    deviceId = existing.device_id
    signingPublicKey = existing.device_public_key
    signingPrivateKey = existing.device_private_key
  } else {
    const signing = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    deviceId = deviceIdFromPublicKey(signing.publicKey)
    signingPublicKey = signing.publicKey
    signingPrivateKey = signing.privateKey
  }
  const exchange = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const identity: DeviceIdentity = {
    device_id: deviceId,
    device_public_key: signingPublicKey,
    device_private_key: signingPrivateKey,
    device_exchange_public_key: exchange.publicKey,
    device_exchange_private_key: exchange.privateKey,
  }
  await mkdir(dirname(DEVICE_IDENTITY_PATH), { recursive: true })
  await writeIdentityAtomic(identity)
  return identity
}

async function writeIdentityAtomic(identity: DeviceIdentity): Promise<void> {
  const temporaryPath = `${DEVICE_IDENTITY_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(identity, null, 2), {
      encoding: 'utf-8', mode: 0o600, flag: 'wx',
    })
    await rename(temporaryPath, DEVICE_IDENTITY_PATH)
    await chmod(DEVICE_IDENTITY_PATH, 0o600)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (!identityPromise) identityPromise = readOrCreateDeviceIdentity()
  return identityPromise
}

export async function getDeviceId(): Promise<string> {
  return (await getDeviceIdentity()).device_id
}

export async function getPublicDeviceTrustInfo(): Promise<PublicDeviceTrustInfo> {
  const identity = await getDeviceIdentity()
  return {
    device_id: identity.device_id,
    device_public_key: identity.device_public_key,
    device_exchange_public_key: identity.device_exchange_public_key,
  }
}

export function createDeviceSigningPayload(payload: {
  device_id: string
  nonce: string
  timestamp: number
}): string {
  return `${payload.device_id}.${payload.nonce}.${payload.timestamp}`
}

export async function createDeviceSignature(nonce: string, timestamp: number): Promise<string> {
  const identity = await getDeviceIdentity()
  return sign(null, Buffer.from(createDeviceSigningPayload({
    device_id: identity.device_id,
    nonce,
    timestamp,
  })), identity.device_private_key).toString('base64url')
}

export function verifyDeviceSignature(input: {
  device_id: string
  device_public_key: string
  nonce: string
  timestamp: number
  signature: string
}): boolean {
  if (deviceIdFromPublicKey(input.device_public_key) !== input.device_id) return false
  try {
    return verify(
      null,
      Buffer.from(createDeviceSigningPayload(input)),
      input.device_public_key,
      Buffer.from(input.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

export async function getPublicSystemInfo(): Promise<PublicSystemInfo> {
  const hermesAgentVersion = normalizeHermesAgentVersion(await hermesCli.getVersion())
  const identity = await getDeviceIdentity()

  return {
    device_id: identity.device_id,
    device_public_key: identity.device_public_key,
    computer_name: hostname(),
    os: {
      type: type(),
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    hermes_agent_version: hermesAgentVersion,
    hermes_web_ui_version: getHermesWebUiVersion(),
  }
}
