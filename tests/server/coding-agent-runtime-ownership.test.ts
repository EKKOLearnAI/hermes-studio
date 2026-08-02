import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { getDb } from '../../packages/server/src/db'
import {
  activateCodingAgentExecution,
  markCodingAgentExecutionTerminal,
  reconcileOrphanedCodingAgentExecutions,
  reserveCodingAgentExecution,
} from '../../packages/server/src/services/agent-runner/coding-agent-runtime-ownership'

const groups = new Set<number>()

function liveGroup(pgid: number): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true
    } catch {}
  }
  return false
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for coding-agent ownership condition')
}

async function spawnOwnedTree(executionId: string): Promise<ChildProcess> {
  const descendant = "process.on('SIGINT',()=>{});setInterval(()=>{},1000)"
  const leader = [
    "const {spawn}=require('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "process.stdout.write('ready\\n')",
    "process.on('SIGINT',()=>process.exit(0))",
    'setInterval(()=>{},1000)',
  ].join(';')
  const child = spawn(process.execPath, ['-e', leader], {
    detached: true,
    env: { ...process.env, HERMES_CODING_EXECUTION_ID: executionId },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (!child.pid || !child.stdout) throw new Error('failed to spawn owned tree')
  groups.add(child.pid)
  await once(child.stdout, 'data')
  return child
}

async function spawnOwnedTreeWithSetsidEscape(executionId: string): Promise<ChildProcess> {
  const escaped = "process.on('SIGINT',()=>{});setInterval(()=>{},1000)"
  const leader = [
    "const {spawn}=require('node:child_process')",
    `const escaped=spawn('setsid',[process.execPath,'-e',${JSON.stringify(escaped)}],{stdio:'ignore'})`,
    "escaped.once('spawn',()=>process.stdout.write(String(escaped.pid)+'\\n'))",
    "process.on('SIGINT',()=>process.exit(0))",
    'setInterval(()=>{},1000)',
  ].join(';')
  const child = spawn(process.execPath, ['-e', leader], {
    detached: true,
    env: { ...process.env, HERMES_CODING_EXECUTION_ID: executionId },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (!child.pid || !child.stdout) throw new Error('failed to spawn owned setsid tree')
  groups.add(child.pid)
  const [chunk] = await once(child.stdout, 'data')
  groups.add(Number(String(chunk).trim()))
  return child
}

afterEach(async () => {
  for (const pgid of groups) {
    try { process.kill(-pgid, 'SIGKILL') } catch {}
    try { await waitFor(() => !liveGroup(pgid), 1_000) } catch {}
  }
  groups.clear()
})

const describeLinux = process.platform === 'linux' ? describe : describe.skip

describeLinux('durable coding-agent runtime ownership', () => {
  beforeEach(() => {
    initAllHermesTables()
    getDb()!.prepare('DELETE FROM coding_agent_runtime_ownership').run()
  })

  it('persists reservation, process identity, checkpoint reference, and terminal state', async () => {
    initAllHermesTables()
    const executionId = `execution-persist-${Date.now()}`
    reserveCodingAgentExecution({
      executionId,
      runId: 'run-persist',
      sessionId: 'session-persist',
      generation: 3,
      workspace: '/tmp/workspace',
      checkpointRef: '/tmp/checkpoint.json',
    })
    activateCodingAgentExecution({ executionId, rootPid: process.pid, processGroupId: process.pid })

    const active = getDb()!.prepare(
      'SELECT * FROM coding_agent_runtime_ownership WHERE execution_id = ?',
    ).get(executionId) as any
    expect(active).toMatchObject({
      execution_id: executionId,
      run_id: 'run-persist',
      session_id: 'session-persist',
      generation: 3,
      state: 'running',
      root_pid: process.pid,
      checkpoint_ref: '/tmp/checkpoint.json',
    })
    expect(String(active.owner_instance_id)).not.toBe('')
    expect(String(active.owner_boot_id)).not.toBe('')
    expect(String(active.root_birth_token)).not.toBe('')

    markCodingAgentExecutionTerminal(executionId, 'completed')
    expect(getDb()!.prepare(
      'SELECT state, terminal_reason, terminal_at FROM coding_agent_runtime_ownership WHERE execution_id = ?',
    ).get(executionId)).toMatchObject({ state: 'terminal', terminal_reason: 'completed' })
  })

  it('recovers a detached orphan by execution nonce before admitting new work', async () => {
    initAllHermesTables()
    const executionId = `execution-orphan-${Date.now()}`
    const child = await spawnOwnedTree(executionId)
    reserveCodingAgentExecution({
      executionId,
      runId: 'run-orphan',
      sessionId: 'session-orphan',
      generation: 1,
      workspace: '/tmp/workspace',
      checkpointRef: '/tmp/orphan-checkpoint.json',
      ownerInstanceId: 'dead-owner-instance',
    })
    activateCodingAgentExecution({
      executionId,
      rootPid: child.pid!,
      processGroupId: child.pid!,
      ownerInstanceId: 'dead-owner-instance',
    })

    expect(liveGroup(child.pid!)).toBe(true)
    const result = await reconcileOrphanedCodingAgentExecutions({ graceMs: 100 })
    expect(result).toMatchObject({ recovered: 1, unresolved: 0 })
    await waitFor(() => !liveGroup(child.pid!))
    expect(getDb()!.prepare(
      'SELECT state, terminal_reason FROM coding_agent_runtime_ownership WHERE execution_id = ?',
    ).get(executionId)).toMatchObject({ state: 'terminal', terminal_reason: 'startup_orphan_recovered' })
  })

  it('quarantines unverifiable non-Linux crash receipts instead of permanently blocking bootstrap', async () => {
    const executionId = `execution-quarantine-${Date.now()}`
    reserveCodingAgentExecution({
      executionId, runId: 'run-quarantine', sessionId: 'session-quarantine', generation: 1,
      workspace: '/tmp/workspace', ownerInstanceId: 'dead-owner-instance',
    })

    const result = await reconcileOrphanedCodingAgentExecutions({ platform: 'darwin' })
    expect(result).toMatchObject({ recovered: 1, unresolved: 0 })
    expect(getDb()!.prepare(
      'SELECT state, terminal_reason FROM coding_agent_runtime_ownership WHERE execution_id = ?',
    ).get(executionId)).toMatchObject({ state: 'terminal', terminal_reason: 'startup_orphan_quarantined' })
  })

  it('recovers a marker-owned descendant that escaped the initial process group with setsid', async () => {
    const executionId = `execution-setsid-${Date.now()}`
    const child = await spawnOwnedTreeWithSetsidEscape(executionId)
    reserveCodingAgentExecution({
      executionId, runId: 'run-setsid', sessionId: 'session-setsid', generation: 1,
      workspace: '/tmp/workspace', ownerInstanceId: 'dead-owner-instance',
    })
    activateCodingAgentExecution({
      executionId, rootPid: child.pid!, processGroupId: child.pid!, ownerInstanceId: 'dead-owner-instance',
    })

    const result = await reconcileOrphanedCodingAgentExecutions({ graceMs: 100 })
    expect(result).toMatchObject({ recovered: 1, unresolved: 0 })
    await waitFor(() => [...groups].every(pgid => !liveGroup(pgid)))
  })
})
