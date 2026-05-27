import dns from 'dns'
import net from 'net'

const PRIVATE_V4_PREFIXES = [
  '10.', '127.', '169.254.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
]

const PRIVATE_V6_PREFIXES = ['fc00:', 'fe80:']

function isPrivateOrReserved(ip: string): boolean {
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1') return true
  const lower = ip.toLowerCase()
  for (const p of PRIVATE_V4_PREFIXES) {
    if (ip.startsWith(p)) return true
  }
  for (const p of PRIVATE_V6_PREFIXES) {
    if (lower.startsWith(p)) return true
  }
  return false
}

/**
 * Resolve a hostname to IPs and check that none are private/reserved.
 * Returns true if the address is safe (all resolved IPs are public).
 */
export async function isSafeUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    // If it's already an IP, check directly
    if (net.isIP(hostname)) {
      return !isPrivateOrReserved(hostname)
    }

    const addresses = await new Promise<string[]>((resolve, reject) => {
      dns.lookup(hostname, { all: true, family: 4 }, (err, addresses) => {
        if (err) reject(err)
        else resolve(addresses.map((a: any) => a.address))
      })
    })

    if (addresses.length === 0) return false

    // DNS rebinding check: if ANY resolved IP is private, reject
    return addresses.every(addr => !isPrivateOrReserved(addr))
  } catch {
    return false
  }
}
