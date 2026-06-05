import { arch, hostname, platform, release, type } from 'os'
import { createHash, generateKeyPairSync, sign, verify } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
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

type DeviceIdentity = {
  device_id: string
  device_public_key: string
  device_private_key: string
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

function isValidDeviceIdentity(value: any): value is DeviceIdentity {
  return typeof value?.device_id === 'string' &&
    value.device_id.length >= 16 &&
    typeof value?.device_public_key === 'string' &&
    value.device_public_key.includes('PUBLIC KEY') &&
    typeof value?.device_private_key === 'string' &&
    value.device_private_key.includes('PRIVATE KEY')
}

export function deviceIdFromPublicKey(publicKey: string): string {
  return `hwui_${createHash('sha256').update(publicKey).digest('base64url').slice(0, 32)}`
}

async function readOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  try {
    const existing = JSON.parse(await readFile(DEVICE_IDENTITY_PATH, 'utf-8'))
    if (isValidDeviceIdentity(existing)) return existing
  } catch {
    // Create a fresh identity below.
  }

  const keyPair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const identity: DeviceIdentity = {
    device_id: deviceIdFromPublicKey(keyPair.publicKey),
    device_public_key: keyPair.publicKey,
    device_private_key: keyPair.privateKey,
  }
  await mkdir(dirname(DEVICE_IDENTITY_PATH), { recursive: true })
  await writeFile(DEVICE_IDENTITY_PATH, JSON.stringify(identity, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return identity
}

export function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (!identityPromise) identityPromise = readOrCreateDeviceIdentity()
  return identityPromise
}

export async function getDeviceId(): Promise<string> {
  return (await getDeviceIdentity()).device_id
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
