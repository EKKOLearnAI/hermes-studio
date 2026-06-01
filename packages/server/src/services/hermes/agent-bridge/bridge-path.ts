import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

export interface McpCliPathOptions {
  platform?: NodeJS.Platform
  resolveNpmGlobalBin?: () => string | undefined
}

function resolveNpmGlobalBinForPlatform(platform: NodeJS.Platform): string | undefined {
  try {
    const npm = platform === 'win32' ? 'npm.cmd' : 'npm'
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
    return platform === 'win32' ? prefix : join(prefix, 'bin')
  } catch {
    return undefined
  }
}

/** Common install locations for stdio MCP CLIs (codegraph, etc.) in GUI/desktop runtimes. */
export function mcpCliPathPrefixes(homeDir = homedir(), options: McpCliPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const npmGlobalBin = options.resolveNpmGlobalBin?.() ?? resolveNpmGlobalBinForPlatform(platform)
  const prefixes = [
    dirname(process.execPath),
    npmGlobalBin,
    join(homeDir, '.npm-global', 'bin'),
    join(homeDir, '.local', 'bin'),
  ]
  if (platform === 'darwin') {
    prefixes.push('/opt/homebrew/bin', '/usr/local/bin')
  }
  return prefixes.filter((entry): entry is string => !!entry && entry.length > 0)
}

export function prependPathEntries(existing: string | undefined, prefixes: string[], pathDelimiter = delimiter): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const entry of [...prefixes, ...(existing || '').split(pathDelimiter)]) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    parts.push(trimmed)
  }
  return parts.join(pathDelimiter)
}

export function augmentBridgePath(
  env: NodeJS.ProcessEnv,
  homeDir = homedir(),
  options: McpCliPathOptions = {},
): string {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const current = env[pathKey] ?? env.PATH ?? ''
  const pathDelimiter = (options.platform ?? process.platform) === 'win32' ? ';' : delimiter
  return prependPathEntries(String(current), mcpCliPathPrefixes(homeDir, options), pathDelimiter)
}
