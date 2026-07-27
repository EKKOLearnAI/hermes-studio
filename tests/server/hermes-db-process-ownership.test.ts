import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const childEntry = fileURLToPath(new URL('./fixtures/hermes-db-process-ownership-child.ts', import.meta.url))
const viteNodeEntry = fileURLToPath(new URL('../../node_modules/vite-node/vite-node.mjs', import.meta.url))

type SpawnedChild = {
  child: ChildProcessWithoutNullStreams
  stdout: string[]
  stderr: string[]
}

const spawnedChildren: SpawnedChild[] = []
const tempDirs: string[] = []

function spawnOwnershipChild(mode: 'hold' | 'probe', dbDir: string): SpawnedChild {
  const child = spawn(process.execPath, [viteNodeEntry, childEntry, mode], {
    env: {
      ...process.env,
      HERMES_WEB_UI_TEST_DB_DIR: dbDir,
      VITEST: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })
  const handle = { child, stdout, stderr }
  spawnedChildren.push(handle)
  return handle
}

function waitForOutput(
  stream: 'stdout' | 'stderr',
  handle: SpawnedChild,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const output = handle[stream].join('')
      if (pattern.test(output)) {
        clearInterval(interval)
        resolve()
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(interval)
        reject(new Error(
          `timed out waiting for ${stream} to match ${pattern}; ` +
          `exit=${handle.child.exitCode}; stdout=${handle.stdout.join('')}; stderr=${handle.stderr.join('')}`,
        ))
      }
    }, 25)
  })
}

function waitForExit(handle: SpawnedChild, timeoutMs = 10_000): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for child exit')), timeoutMs)
    handle.child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code })
    })
  })
}

afterEach(async () => {
  for (const handle of spawnedChildren.splice(0)) {
    if (handle.child.exitCode === null) {
      handle.child.stdin.end()
      handle.child.kill()
      try {
        await waitForExit(handle, 1_500)
      } catch {
        // best effort
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('Hermes DB process ownership', () => {
  it('fails closed in a second process before schema/application use', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'hermes-db-owner-'))
    tempDirs.push(dbDir)

    const owner = spawnOwnershipChild('hold', dbDir)
    await waitForOutput('stdout', owner, /"status":"ready"/)

    const contender = spawnOwnershipChild('probe', dbDir)
    const result = await waitForExit(contender)

    expect(result.code).toBe(2)
    expect(contender.stdout.join('')).not.toContain('"status":"acquired"')
    expect(contender.stderr.join('')).toMatch(/database is locked/i)
  }, 20_000)

  it('reacquires ownership after closeDb releases the lock', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'hermes-db-owner-'))
    tempDirs.push(dbDir)

    const owner = spawnOwnershipChild('hold', dbDir)
    await waitForOutput('stdout', owner, /"status":"ready"/)

    owner.child.stdin.write('close\n')
    expect(await waitForExit(owner)).toEqual({ code: 0 })

    const reacquired = spawnOwnershipChild('probe', dbDir)
    expect(await waitForExit(reacquired)).toEqual({ code: 0 })
    expect(reacquired.stdout.join('')).toContain('"status":"acquired"')
  }, 20_000)

  it('reacquires ownership after the owning process terminates unexpectedly', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'hermes-db-owner-'))
    tempDirs.push(dbDir)

    const owner = spawnOwnershipChild('hold', dbDir)
    await waitForOutput('stdout', owner, /"status":"ready"/)

    owner.child.stdin.write('crash\n')
    expect(await waitForExit(owner)).toEqual({ code: 17 })

    const reacquired = spawnOwnershipChild('probe', dbDir)
    expect(await waitForExit(reacquired)).toEqual({ code: 0 })
    expect(reacquired.stdout.join('')).toContain('"status":"acquired"')
  }, 20_000)
})
