import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

type DpapiOperation = 'protect' | 'unprotect'
type DpapiRunner = (operation: DpapiOperation, input: Buffer) => Buffer

export interface FabricAuditKeyProviderOptions {
  directory: string
  platform?: NodeJS.Platform
  runDpapi?: DpapiRunner
}

const DPAPI_FORMAT = 'dpapi-v1:'

export class FabricAuditKeyProvider {
  private readonly directory: string
  private readonly platform: NodeJS.Platform
  private readonly runDpapi: DpapiRunner
  private cachedLocalKey: Buffer | null = null

  constructor(options: FabricAuditKeyProviderOptions) {
    this.directory = options.directory
    this.platform = options.platform ?? process.platform
    this.runDpapi = options.runDpapi ?? runWindowsDpapi
  }

  getKey(): Buffer {
    const managed = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    if (managed !== undefined) return parseAuditKey(managed)
    if (this.cachedLocalKey !== null) return this.cachedLocalKey
    this.cachedLocalKey = this.platform === 'win32' ? this.loadWindowsKey() : this.loadPosixKey()
    return this.cachedLocalKey
  }

  private loadWindowsKey(): Buffer {
    mkdirSync(this.directory, { recursive: true })
    const path = join(this.directory, '.action-fabric-audit-key.dpapi')
    let stored: string
    try {
      stored = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
      const key = randomBytes(32)
      let protectedKey: Buffer
      try {
        protectedKey = this.runDpapi('protect', key)
      } catch {
        throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
      }
      if (protectedKey.length === 0) throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
      const encoded = `${DPAPI_FORMAT}${protectedKey.toString('base64')}`
      try {
        writeFileSync(path, encoded, { encoding: 'utf8', flag: 'wx' })
        return key
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
        }
        try {
          stored = readFileSync(path, 'utf8')
        } catch {
          throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
        }
      }
    }
    if (!stored.startsWith(DPAPI_FORMAT)) throw new Error('FABRIC_AUDIT_KEY_INVALID')
    const encoded = stored.slice(DPAPI_FORMAT.length)
    if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error('FABRIC_AUDIT_KEY_INVALID')
    try {
      const key = this.runDpapi('unprotect', Buffer.from(encoded, 'base64'))
      if (key.length < 32 || key.length > 256) throw new Error('invalid')
      return key
    } catch {
      throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
    }
  }

  private loadPosixKey(): Buffer {
    mkdirSync(this.directory, { recursive: true })
    const path = join(this.directory, '.action-fabric-audit-key')
    try {
      writeFileSync(path, randomBytes(32).toString('hex'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
    }
    if ((stat.mode & 0o077) !== 0) throw new Error('FABRIC_AUDIT_KEY_PERMISSIONS')
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('FABRIC_AUDIT_KEY_PERMISSIONS')
    }
    try {
      return parseAuditKey(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FABRIC_AUDIT_KEY_')) throw error
      throw new Error('FABRIC_AUDIT_KEY_UNAVAILABLE')
    }
  }
}

export function parseAuditKey(value: string): Buffer {
  let key: Buffer
  if (/^(?:hex:)?[a-f0-9]{64,}$/i.test(value)) {
    const encoded = value.toLowerCase().startsWith('hex:') ? value.slice(4) : value
    if (encoded.length % 2 !== 0) throw new Error('FABRIC_AUDIT_KEY_INVALID')
    key = Buffer.from(encoded, 'hex')
  } else if (value.startsWith('base64:')) {
    const encoded = value.slice(7)
    if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error('FABRIC_AUDIT_KEY_INVALID')
    key = Buffer.from(encoded, 'base64')
  } else if (/^[\x20-\x7e]{32,256}$/.test(value)) {
    key = Buffer.from(value, 'utf8')
  } else {
    throw new Error('FABRIC_AUDIT_KEY_INVALID')
  }
  if (key.length < 32 || key.length > 256) throw new Error('FABRIC_AUDIT_KEY_INVALID')
  return key
}

const DPAPI_SCRIPT = String.raw`
$inputText = [Console]::In.ReadToEnd()
$parts = $inputText.Split([char]10, 2)
if ($parts.Length -ne 2) { exit 2 }
$operation = $parts[0].Trim()
$data = [Convert]::FromBase64String($parts[1].Trim())
Add-Type -AssemblyName System.Security
if ($operation -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} elseif ($operation -eq 'unprotect') {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else { exit 3 }
[Console]::Out.Write([Convert]::ToBase64String($result))
`

function runWindowsDpapi(operation: DpapiOperation, input: Buffer): Buffer {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    input: `${operation}\n${input.toString('base64')}`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('DPAPI unavailable')
  const output = result.stdout.trim()
  if (!/^[a-z0-9+/]+={0,2}$/i.test(output)) throw new Error('DPAPI unavailable')
  return Buffer.from(output, 'base64')
}
