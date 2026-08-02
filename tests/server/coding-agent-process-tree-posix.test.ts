import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { CodingAgentRunManager } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'

const spawnedGroups = new Set<number>()
const tempDirs = new Set<string>()

function groupExists(pgid: number): boolean {
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        if (close < 0) continue
        const fields = stat.slice(close + 2).split(' ')
        const state = fields[0]
        const processGroup = Number.parseInt(fields[2] || '', 10)
        if (processGroup === pgid && state !== 'Z' && state !== 'X') return true
      } catch {}
    }
    return false
  }
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for process condition')
}

async function spawnLeaderWithSignalResistantDescendant(): Promise<{ leader: ChildProcess; descendantPid: number }> {
  const descendantSource = [
    "process.on('SIGINT', () => {})",
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leaderSource = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'))",
    "process.on('SIGINT', () => process.exit(0))",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leader = spawn(process.execPath, ['-e', leaderSource], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (!leader.pid || !leader.stdout) throw new Error('failed to spawn process-group probe')
  spawnedGroups.add(leader.pid)
  let stdout = ''
  leader.stdout.setEncoding('utf8')
  leader.stdout.on('data', chunk => { stdout += chunk })
  await waitFor(() => /^\d+\n/.test(stdout))
  return { leader, descendantPid: Number.parseInt(stdout.trim(), 10) }
}

function createNaturalExitCodingAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coding-agent-natural-exit-'))
  tempDirs.add(dir)
  const script = join(dir, 'fake-coding-agent.cjs')
  const descendantSource = [
    "process.on('SIGINT', () => {})",
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' })`,
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'done',session_id:'native-test'})+'\\n')",
    "process.stderr.write('descendant='+child.pid+'\\n')",
    'setTimeout(() => process.exit(0), 20)',
  ].join('\n'))
  chmodSync(script, 0o755)
  return script
}

afterEach(async () => {
  for (const pgid of spawnedGroups) {
    try { process.kill(-pgid, 'SIGKILL') } catch {}
    try { await waitFor(() => !groupExists(pgid), 1_000) } catch {}
  }
  spawnedGroups.clear()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('CodingAgentRunManager POSIX process-tree finalization', () => {
  it('keeps the run indexed until the complete process group is gone', async () => {
    const { leader, descendantPid } = await spawnLeaderWithSignalResistantDescendant()
    const manager = new CodingAgentRunManager()
    const sessionId = `session-process-tree-${Date.now()}`
    const runId = `run-process-tree-${Date.now()}`
    const run: any = {
      id: runId,
      incarnationToken: `incarnation-${runId}`,
      launch: { agentId: 'codex', sessionId, workspaceDir: process.cwd() },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: leader,
      currentProcessGroupId: leader.pid,
      activeEventToken: 'turn-process-tree',
    }
    ;(manager as any).runs.set(runId, run)
    ;(manager as any).sessionIndex.set(sessionId, runId)
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => null

    const stopping = manager.stopAndWait(sessionId, { reportClosed: false, graceMs: 100 })
    await once(leader, 'exit')

    expect(groupExists(leader.pid!)).toBe(true)
    expect(() => process.kill(descendantPid, 0)).not.toThrow()
    expect(manager.runIdForSession(sessionId)).toBe(runId)

    await expect(stopping).resolves.toBe(true)
    await waitFor(() => !groupExists(leader.pid!))
    expect(manager.runIdForSession(sessionId)).toBeUndefined()
  })

  it('does not publish completion or release queued work until descendants of a naturally exited leader are gone', async () => {
    initAllHermesTables()
    const command = createNaturalExitCodingAgent()
    const manager = new CodingAgentRunManager()
    const sessionId = `session-natural-exit-${Date.now()}`
    const runId = `run-natural-exit-${Date.now()}`
    const emitted: string[] = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = () => { emitted.push('completed') }
    ;(manager as any).emitToChat = (_sessionId: string, event: string) => { emitted.push(event) }
    ;(manager as any).startWorkspaceRunDiff = () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => null

    manager.start({
      agentSessionId: runId,
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId,
      command,
      args: [],
      shellCommand: command,
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [{ queue_id: 'queued', input: 'next' }] } as any,
    })
    manager.send(sessionId, 'run')
    const run = (manager as any).runs.get(runId)
    await waitFor(() => Boolean(run.currentProcessGroupId))
    const pgid = run.currentProcessGroupId as number
    spawnedGroups.add(pgid)
    await waitFor(() => run.currentChild?.exitCode !== null, 2_000)

    expect(groupExists(pgid)).toBe(true)
    expect(emitted).not.toContain('completed')
    expect(run.state.queue).toHaveLength(1)

    await waitFor(() => !groupExists(pgid), 3_000)
    await waitFor(() => emitted.includes('completed'), 2_000)
    expect(run.state.queue).toHaveLength(1)
    await manager.stopAndWait(sessionId, { reportClosed: false, graceMs: 100 })
  })
})
