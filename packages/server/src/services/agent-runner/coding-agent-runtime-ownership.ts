import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { getDb } from '../../db'
import { CODING_AGENT_RUNTIME_OWNERSHIP_TABLE } from '../../db/hermes/schemas'
import { completeWorkspaceRunCheckpoint } from '../hermes/run-chat/workspace-diff-tracker'

export type CodingAgentTerminalReason =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'shutdown'
  | 'startup_orphan_recovered'
  | 'startup_orphan_quarantined'

export interface ProcessIdentity {
  pid: number
  pgrp: number
  state: string
  birthToken: string
}

export interface ReserveCodingAgentExecutionInput {
  executionId: string
  runId: string
  sessionId: string
  generation: number
  workspace: string
  checkpointRef?: string | null
  ownerInstanceId?: string
}

export interface ActivateCodingAgentExecutionInput {
  executionId: string
  rootPid: number
  processGroupId?: number
  boundaryKind?: string
  ownerInstanceId?: string
}

const bootId = readText('/proc/sys/kernel/random/boot_id') || `platform:${process.platform}`
const ownerBirthToken = processIdentity(process.pid)?.birthToken || ''
export const codingAgentRuntimeOwnerInstanceId = `${bootId}:${process.pid}:${ownerBirthToken}:${randomUUID()}`

function readText(path: string): string {
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}

function processIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(' ')
    const pgrp = Number.parseInt(fields[2] || '', 10)
    const startTicks = String(fields[19] || '')
    if (!Number.isInteger(pgrp) || !startTicks) return null
    return { pid, pgrp, state: fields[0] || '', birthToken: `${bootId}:${startTicks}` }
  } catch {
    return null
  }
}

function currentProcessGroup(): number | null {
  return processIdentity(process.pid)?.pgrp || null
}

export function codingAgentExecutionProcesses(executionId: string): ProcessIdentity[] {
  if (process.platform !== 'linux') return []
  const marker = `HERMES_CODING_EXECUTION_ID=${executionId}`
  const matches: ProcessIdentity[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const environment = readFileSync(`/proc/${entry}/environ`)
        .toString('utf8')
        .split('\0')
      if (!environment.includes(marker)) continue
      const identity = processIdentity(Number(entry))
      if (identity && identity.state !== 'Z' && identity.state !== 'X') matches.push(identity)
    } catch {
      // Processes can disappear or be unreadable while /proc is scanned.
    }
  }
  return matches
}

function updateState(executionId: string, state: string, terminalReason = ''): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const now = Date.now()
  db.prepare(
    `UPDATE ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE}
     SET state = ?, terminal_reason = ?, terminal_at = CASE WHEN ? = 'terminal' THEN ? ELSE terminal_at END,
         updated_at = ? WHERE execution_id = ?`,
  ).run(state, terminalReason, state, now, now, executionId)
}

export function reserveCodingAgentExecution(input: ReserveCodingAgentExecutionInput): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const now = Date.now()
  const ownerInstanceId = input.ownerInstanceId || codingAgentRuntimeOwnerInstanceId
  db.prepare(
    `INSERT INTO ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE} (
       execution_id, run_id, session_id, generation, owner_instance_id, owner_pid,
       owner_birth_token, owner_boot_id, state, workspace, checkpoint_ref, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'spawning', ?, ?, ?, ?)`,
  ).run(
    input.executionId,
    input.runId,
    input.sessionId,
    input.generation,
    ownerInstanceId,
    process.pid,
    ownerBirthToken,
    bootId,
    input.workspace,
    input.checkpointRef || '',
    now,
    now,
  )
}

export function activateCodingAgentExecution(input: ActivateCodingAgentExecutionInput): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const identity = processIdentity(input.rootPid)
  if (process.platform === 'linux' && !identity) {
    throw new Error(`Cannot verify coding agent root process identity for pid ${input.rootPid}`)
  }
  const boundaryKind = input.boundaryKind || (process.platform === 'win32' ? 'windows_unverified' : 'posix_process_group')
  const processGroupId = input.processGroupId ?? identity?.pgrp ?? null
  const ownerInstanceId = input.ownerInstanceId || codingAgentRuntimeOwnerInstanceId
  const result = db.prepare(
    `UPDATE ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE}
     SET owner_instance_id = ?, owner_pid = ?, owner_birth_token = ?, owner_boot_id = ?,
         root_pid = ?, root_birth_token = ?, process_group_id = ?, boundary_kind = ?,
         state = 'running', updated_at = ?
     WHERE execution_id = ? AND state = 'spawning'`,
  ).run(
    ownerInstanceId,
    process.pid,
    ownerBirthToken,
    bootId,
    input.rootPid,
    identity?.birthToken || '',
    processGroupId,
    boundaryKind,
    Date.now(),
    input.executionId,
  )
  if (Number(result.changes || 0) !== 1) {
    throw new Error(`Coding agent execution reservation is missing or no longer activatable: ${input.executionId}`)
  }
}

export function prepareCodingAgentExecutionTurn(executionId: string, generation: number): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const result = db.prepare(
    `UPDATE ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE}
     SET generation = ?, root_pid = NULL, root_birth_token = '', process_group_id = NULL,
         boundary_kind = '', state = 'spawning', terminal_reason = '', updated_at = ?
     WHERE execution_id = ? AND state <> 'terminal'`,
  ).run(generation, Date.now(), executionId)
  if (Number(result.changes || 0) !== 1) throw new Error(`Coding agent execution is not active: ${executionId}`)
}

export function markCodingAgentExecutionIdle(executionId: string): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  db.prepare(
    `UPDATE ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE}
     SET root_pid = NULL, root_birth_token = '', process_group_id = NULL,
         boundary_kind = '', state = 'idle', updated_at = ?
     WHERE execution_id = ? AND state <> 'terminal'`,
  ).run(Date.now(), executionId)
}

export function updateCodingAgentExecutionCheckpoint(executionId: string, checkpointRef: string | null): void {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  db.prepare(
    `UPDATE ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE} SET checkpoint_ref = ?, updated_at = ? WHERE execution_id = ?`,
  ).run(checkpointRef || '', Date.now(), executionId)
}

export function markCodingAgentExecutionTreeGone(executionId: string): void {
  updateState(executionId, 'tree_gone')
}

export function finalizeCodingAgentExecutionEvidence(
  sessionId: string,
  reason: CodingAgentTerminalReason,
): boolean {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const row = db.prepare(
    `SELECT execution_id FROM ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE}
     WHERE session_id = ? AND state = 'tree_gone' ORDER BY updated_at DESC LIMIT 1`,
  ).get(sessionId) as { execution_id?: string } | undefined
  const executionId = String(row?.execution_id || '')
  if (!executionId) return false
  updateState(executionId, 'evidence_captured')
  markCodingAgentExecutionTerminal(executionId, reason)
  return true
}

export function markCodingAgentExecutionStopping(executionId: string): void {
  updateState(executionId, 'stopping')
}

export function markCodingAgentExecutionUnresolved(executionId: string, reason: string): void {
  updateState(executionId, 'unresolved', reason)
}

export function markCodingAgentExecutionTerminal(executionId: string, reason: CodingAgentTerminalReason): void {
  updateState(executionId, 'terminal', reason)
}

function recoverWorkspaceEvidence(row: any): boolean {
  const checkpointRef = String(row.checkpoint_ref || '')
  if (!checkpointRef || !existsSync(checkpointRef)) return true
  try {
    completeWorkspaceRunCheckpoint({
      sessionId: String(row.session_id || ''),
      runId: String(row.run_id || ''),
      workspace: String(row.workspace || ''),
    })
    return !existsSync(checkpointRef)
  } catch {
    return false
  }
}

function signalGroups(groups: Set<number>, signal: 'SIGINT' | 'SIGKILL'): boolean {
  const ownGroup = currentProcessGroup()
  for (const pgid of groups) {
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === ownGroup) return false
  }
  for (const pgid of groups) {
    try { process.kill(-pgid, signal) } catch (error: any) {
      if (error?.code !== 'ESRCH') return false
    }
  }
  return true
}

async function waitForExecutionGone(executionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (codingAgentExecutionProcesses(executionId).length === 0) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() <= deadline)
  return codingAgentExecutionProcesses(executionId).length === 0
}

export async function reconcileOrphanedCodingAgentExecutions(
  options: { graceMs?: number; platform?: NodeJS.Platform } = {},
): Promise<{ recovered: number; unresolved: number; skippedCurrent: number }> {
  const db = getDb()
  if (!db) throw new Error('Coding agent runtime ownership database is unavailable')
  const rows = db.prepare(
    `SELECT * FROM ${CODING_AGENT_RUNTIME_OWNERSHIP_TABLE} WHERE state <> 'terminal' ORDER BY created_at`,
  ).all() as any[]
  let recovered = 0
  let unresolved = 0
  let skippedCurrent = 0

  for (const row of rows) {
    const executionId = String(row.execution_id || '')
    if (!executionId) continue
    if (String(row.owner_instance_id || '') === codingAgentRuntimeOwnerInstanceId) {
      skippedCurrent += 1
      continue
    }
    if ((options.platform || process.platform) !== 'linux') {
      // These platforms do not currently provide a durable, restart-verifiable
      // process boundary. Quarantine the stale ownership receipt so bootstrap
      // cannot loop forever, while preserving an explicit audit terminal state.
      // New Coding Agent work remains fail-closed in CodingAgentRunManager.
      if (!recoverWorkspaceEvidence(row)) {
        markCodingAgentExecutionUnresolved(executionId, 'startup_quarantine_workspace_evidence_pending')
        unresolved += 1
        continue
      }
      markCodingAgentExecutionTerminal(executionId, 'startup_orphan_quarantined')
      recovered += 1
      continue
    }

    let processes = codingAgentExecutionProcesses(executionId)
    const storedRoot = processIdentity(Number(row.root_pid || 0))
    if (
      storedRoot &&
      String(row.root_birth_token || '') &&
      storedRoot.birthToken === String(row.root_birth_token) &&
      !processes.some(item => item.pid === storedRoot.pid)
    ) {
      processes.push(storedRoot)
    }

    if (processes.length === 0) {
      if (!recoverWorkspaceEvidence(row)) {
        markCodingAgentExecutionUnresolved(executionId, 'startup_workspace_evidence_pending')
        unresolved += 1
        continue
      }
      markCodingAgentExecutionTerminal(executionId, 'startup_orphan_recovered')
      recovered += 1
      continue
    }

    const groups = new Set(processes.map(item => item.pgrp))
    if (!signalGroups(groups, 'SIGINT')) {
      markCodingAgentExecutionUnresolved(executionId, 'startup_orphan_signal_rejected')
      unresolved += 1
      continue
    }
    let gone = await waitForExecutionGone(executionId, options.graceMs ?? 1_500)
    if (!gone) {
      processes = codingAgentExecutionProcesses(executionId)
      const remainingGroups = new Set(processes.map(item => item.pgrp))
      if (!signalGroups(remainingGroups, 'SIGKILL')) {
        markCodingAgentExecutionUnresolved(executionId, 'startup_orphan_force_signal_rejected')
        unresolved += 1
        continue
      }
      gone = await waitForExecutionGone(executionId, 2_000)
    }
    if (!gone) {
      markCodingAgentExecutionUnresolved(executionId, 'startup_orphan_tree_still_alive')
      unresolved += 1
      continue
    }

    if (!recoverWorkspaceEvidence(row)) {
      markCodingAgentExecutionUnresolved(executionId, 'startup_workspace_evidence_pending')
      unresolved += 1
      continue
    }
    markCodingAgentExecutionTerminal(executionId, 'startup_orphan_recovered')
    recovered += 1
  }

  return { recovered, unresolved, skippedCurrent }
}
