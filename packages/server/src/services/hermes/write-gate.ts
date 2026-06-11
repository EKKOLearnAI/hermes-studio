import { execFile } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import { getHermesBin } from './hermes-path'
import { getHermesBaseDir, getProfileDir } from './hermes-profile'

const execFileAsync = promisify(execFile)
const SUBSYSTEMS = new Set(['memory', 'skills'])
const PENDING_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export type WriteGateSubsystem = 'memory' | 'skills'

export interface PendingWriteRecord {
  id: string
  subsystem: WriteGateSubsystem
  action: string
  summary: string
  origin: string
  created_at: number | null
  payload: Record<string, any>
}

export interface PendingWritesResponse {
  records: PendingWriteRecord[]
  counts: Record<WriteGateSubsystem, number>
}

const PYTHON_HELPER = String.raw`
import json
import os
import sys

agent_root, subsystem, action, pending_id = sys.argv[1:5]
if agent_root and agent_root not in sys.path:
    sys.path.insert(0, agent_root)

from tools import write_approval as wa
from hermes_cli.write_approval_commands import handle_pending_subcommand

if subsystem == "memory":
    wa_subsystem = wa.MEMORY
elif subsystem == "skills":
    wa_subsystem = wa.SKILLS
else:
    raise SystemExit(f"invalid subsystem: {subsystem}")

if action == "diff":
    rec = wa.get_pending(wa_subsystem, pending_id)
    if not rec:
        raise SystemExit(f"No pending {subsystem} write with id '{pending_id}'.")
    if subsystem == "skills":
        output = wa.skill_pending_diff(rec)
    else:
        output = json.dumps(rec.get("payload", {}), ensure_ascii=False, indent=2)
elif action in {"approve", "reject"}:
    memory_store = None
    if subsystem == "memory" and action == "approve":
        from tools.memory_tool import MemoryStore
        memory_store = MemoryStore()
        memory_store.load_from_disk()
    output = handle_pending_subcommand(
        wa_subsystem,
        [action, pending_id],
        memory_store=memory_store,
    )
else:
    raise SystemExit(f"invalid action: {action}")

print(json.dumps({"output": output}, ensure_ascii=False))
`

function assertSubsystem(value: string): asserts value is WriteGateSubsystem {
  if (!SUBSYSTEMS.has(value)) throw new Error('Invalid write gate subsystem')
}

function assertPendingId(value: string): void {
  if (!PENDING_ID_RE.test(value)) throw new Error('Invalid pending write id')
}

function pendingDir(profile: string, subsystem: WriteGateSubsystem): string {
  return join(getProfileDir(profile || 'default'), 'pending', subsystem)
}

function normalizeRecord(raw: any, subsystem: WriteGateSubsystem, fallbackId: string): PendingWriteRecord | null {
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
  if (!PENDING_ID_RE.test(id)) return null
  return {
    id,
    subsystem,
    action: typeof raw?.action === 'string' ? raw.action : '',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    origin: typeof raw?.origin === 'string' ? raw.origin : 'foreground',
    created_at: typeof raw?.created_at === 'number' && Number.isFinite(raw.created_at) ? raw.created_at : null,
    payload: raw?.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {},
  }
}

async function listPendingFor(profile: string, subsystem: WriteGateSubsystem): Promise<PendingWriteRecord[]> {
  const dir = pendingDir(profile, subsystem)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const records: PendingWriteRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const fallbackId = entry.slice(0, -'.json'.length)
    if (!PENDING_ID_RE.test(fallbackId)) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf-8'))
      const record = normalizeRecord(raw, subsystem, fallbackId)
      if (record) records.push(record)
    } catch {
      // Skip unreadable records, matching Hermes Agent's pending list behavior.
    }
  }
  return records.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
}

export async function listPendingWrites(profile: string): Promise<PendingWritesResponse> {
  const [memory, skills] = await Promise.all([
    listPendingFor(profile, 'memory'),
    listPendingFor(profile, 'skills'),
  ])
  return {
    records: [...memory, ...skills].sort((a, b) => (a.created_at || 0) - (b.created_at || 0)),
    counts: {
      memory: memory.length,
      skills: skills.length,
    },
  }
}

function pathCandidates(command: string): string[] {
  if (isAbsolute(command) || command.includes('/')) return [command]
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  return (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap(dir => extensions.map(ext => join(dir, `${command}${ext}`)))
}

function pythonFromShebang(file: string): string | null {
  try {
    const real = realpathSync(file)
    const firstLine = readFileSync(real, 'utf-8').split(/\r?\n/, 1)[0] || ''
    if (!firstLine.startsWith('#!')) return null
    const command = firstLine.slice(2).trim().split(/\s+/)
    if (command[0]?.endsWith('/env') && command[1]) return command[1]
    return command[0] || null
  } catch {
    return null
  }
}

function hermesShebangPython(): string | null {
  for (const candidate of pathCandidates(getHermesBin())) {
    if (!existsSync(candidate)) continue
    const python = pythonFromShebang(candidate)
    if (python) return python
  }
  return null
}

function agentRootFromPython(python: string | null): string {
  if (!python || !isAbsolute(python)) return ''
  try {
    const real = realpathSync(python)
    const binDir = dirname(real)
    const venvDir = dirname(binDir)
    if (basename(venvDir) === 'venv') return dirname(venvDir)
  } catch {}
  return ''
}

function agentRootCandidates(): string[] {
  const shebangPython = hermesShebangPython()
  return [
    process.env.HERMES_AGENT_ROOT?.trim() || '',
    join(getHermesBaseDir(), 'hermes-agent'),
    join(homedir(), '.hermes', 'hermes-agent'),
    agentRootFromPython(shebangPython),
  ].filter(Boolean)
}

function resolveAgentRoot(): string {
  for (const candidate of agentRootCandidates()) {
    if (existsSync(join(candidate, 'tools', 'write_approval.py'))) return resolve(candidate)
  }
  throw new Error('Hermes Agent source not found. Set HERMES_AGENT_ROOT to enable write approval actions.')
}

function resolveHermesPython(agentRoot: string): string {
  const envPython = process.env.HERMES_AGENT_CLI_PYTHON?.trim()
  if (envPython) return envPython

  const venvPython = process.platform === 'win32'
    ? join(agentRoot, 'venv', 'Scripts', 'python.exe')
    : join(agentRoot, 'venv', 'bin', 'python3')
  if (existsSync(venvPython)) return venvPython

  const shebangPython = hermesShebangPython()
  if (shebangPython) return shebangPython

  return process.platform === 'win32' ? 'python' : 'python3'
}

async function runPythonAction(
  profile: string,
  subsystem: WriteGateSubsystem,
  action: 'approve' | 'reject' | 'diff',
  pendingId: string,
): Promise<string> {
  assertSubsystem(subsystem)
  assertPendingId(pendingId)
  const agentRoot = resolveAgentRoot()
  const python = resolveHermesPython(agentRoot)
  const profileDir = getProfileDir(profile || 'default')
  const pythonPath = [agentRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter)
  const { stdout } = await execFileAsync(
    python,
    ['-c', PYTHON_HELPER, agentRoot, subsystem, action, pendingId],
    {
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
        PYTHONPATH: pythonPath,
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const parsed = JSON.parse(String(stdout || '{}'))
  return typeof parsed.output === 'string' ? parsed.output : ''
}

export async function getPendingWriteDiff(profile: string, subsystem: string, pendingId: string): Promise<string> {
  assertSubsystem(subsystem)
  return runPythonAction(profile, subsystem, 'diff', pendingId)
}

export async function approvePendingWrite(profile: string, subsystem: string, pendingId: string): Promise<string> {
  assertSubsystem(subsystem)
  return runPythonAction(profile, subsystem, 'approve', pendingId)
}

export async function rejectPendingWrite(profile: string, subsystem: string, pendingId: string): Promise<string> {
  assertSubsystem(subsystem)
  return runPythonAction(profile, subsystem, 'reject', pendingId)
}
