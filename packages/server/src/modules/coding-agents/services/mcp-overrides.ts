import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getWebUiHome } from '../../studio/public/config'

interface ManagedMcpOverrides {
  disabled?: Record<string, Record<string, string[]>>
}

function overridesPath(): string {
  return join(getWebUiHome(), 'coding-agent', 'mcp-overrides.json')
}

function readOverrides(): ManagedMcpOverrides {
  const path = overridesPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeOverrides(value: ManagedMcpOverrides): void {
  const path = overridesPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(path, 0o600)
}

export function getDisabledManagedMcpServers(id: string, profile = 'default'): Set<string> {
  const values = readOverrides().disabled?.[id]?.[profile] || []
  return new Set(values.map(String).filter(Boolean))
}

export function setManagedMcpServerEnabled(
  id: string,
  profile: string,
  name: string,
  enabled: boolean,
): void {
  const value = readOverrides()
  const disabled = value.disabled ||= {}
  const byAgent = disabled[id] ||= {}
  const names = new Set((byAgent[profile] || []).map(String).filter(Boolean))
  if (enabled) names.delete(name)
  else names.add(name)
  if (names.size) byAgent[profile] = [...names].sort()
  else delete byAgent[profile]
  if (!Object.keys(byAgent).length) delete disabled[id]
  if (!Object.keys(disabled).length) delete value.disabled
  writeOverrides(value)
}
