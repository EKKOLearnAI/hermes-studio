import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

function resolveNpmGlobalBin(): string | undefined {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const prefix = execFileSync(npm, ['prefix', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      },
      windowsHide: true,
    }).trim()
    if (!prefix) return undefined
    return process.platform === 'win32' ? prefix : join(prefix, 'bin')
  } catch {
    return undefined
  }
}

/** Common install locations for stdio MCP CLIs (codegraph, etc.) in GUI/desktop runtimes. */
export function mcpCliPathPrefixes(homeDir = homedir()): string[] {
  const prefixes = [
    dirname(process.execPath),
    resolveNpmGlobalBin(),
    join(homeDir, '.npm-global', 'bin'),
    join(homeDir, '.local', 'bin'),
  ]
  if (process.platform === 'darwin') {
    prefixes.push('/opt/homebrew/bin', '/usr/local/bin')
  }
  return prefixes.filter((entry): entry is string => !!entry && entry.length > 0)
}

export function prependPathEntries(existing: string | undefined, prefixes: string[]): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const entry of [...prefixes, ...(existing || '').split(delimiter)]) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    parts.push(trimmed)
  }
  return parts.join(delimiter)
}

export function augmentBridgePath(env: NodeJS.ProcessEnv, homeDir = homedir()): string {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const current = env[pathKey] ?? env.PATH ?? ''
  return prependPathEntries(String(current), mcpCliPathPrefixes(homeDir))
}
