import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runStartupTasks, type StartupTask } from '../../packages/server/src/modules/studio/services/startup-tasks'
import { safeFileStore } from '../../packages/server/src/modules/studio/public/safe-file-store'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

let home: string
let stateFile: string
const task = (id: string, run = vi.fn(async () => {}), scope = 'test-data'): StartupTask => ({ id, title: id, scope, run })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'studio-startup-tasks-'))
  stateFile = join(home, 'startup-tasks.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe('persistent startup tasks', () => {
  it('records success, skips it after restart without writing, and runs only newly added tasks', async () => {
    const first = task('first-v1')
    expect(await runStartupTasks([first], stateFile)).toEqual({ completed: ['first-v1'], skipped: [], failed: [] })
    const raw = readFileSync(stateFile, 'utf8')
    const record = JSON.parse(raw).tasks[0]
    expect(record).toMatchObject({ id: 'first-v1', scope: 'test-data', status: 'completed', attempts: 1 })
    expect(Number.isFinite(Date.parse(record.completedAt))).toBe(true)
    const modified = statSync(stateFile).mtimeMs
    const afterRestart = task('first-v1')
    expect(await runStartupTasks([afterRestart], stateFile)).toEqual({ completed: [], skipped: ['first-v1'], failed: [] })
    expect(afterRestart.run).not.toHaveBeenCalled()
    expect(readFileSync(stateFile, 'utf8')).toBe(raw)
    expect(statSync(stateFile).mtimeMs).toBe(modified)

    const next = task('second-v1')
    await runStartupTasks([afterRestart, next], stateFile)
    expect(afterRestart.run).not.toHaveBeenCalled()
    expect(next.run).toHaveBeenCalledOnce()
    expect(readFileSync(`${stateFile}.bak`, 'utf8')).toBe(raw)
  })

  it('checkpoints each success, stops after failure, and retries unfinished work in order', async () => {
    const order: string[] = []
    const first = task('first', vi.fn(async () => { order.push('first') }))
    const second = task('second', vi.fn(async () => {
      order.push('second')
      expect(JSON.parse(readFileSync(stateFile, 'utf8')).tasks[0].status).toBe('completed')
      throw new Error('test failure')
    }))
    const third = task('third', vi.fn(async () => { order.push('third') }))
    expect(await runStartupTasks([first, second, third], stateFile)).toEqual({ completed: ['first'], skipped: [], failed: ['second'] })
    expect(order).toEqual(['first', 'second'])
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).tasks[1]).toMatchObject({ status: 'failed', attempts: 1 })
    second.run = vi.fn(async () => { order.push('second retry') })
    expect(await runStartupTasks([first, second, third], stateFile)).toEqual({ completed: ['second', 'third'], skipped: ['first'], failed: [] })
    expect(order).toEqual(['first', 'second', 'second retry', 'third'])
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).tasks[1]).toMatchObject({ status: 'completed', attempts: 2 })
  })

  it('tracks the same operation separately for different data directories', async () => {
    const first = task('replace-domain', vi.fn(async () => {}), '/data/hermes-a')
    const second = task('replace-domain', vi.fn(async () => {}), '/data/hermes-b')
    await runStartupTasks([first], stateFile)
    await runStartupTasks([second], stateFile)
    await runStartupTasks([first], stateFile)
    expect(first.run).toHaveBeenCalledOnce()
    expect(second.run).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).tasks).toHaveLength(2)
  })

  it('serializes concurrent callers before running a pending task', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const pending = task('pending', vi.fn(async () => { await paused }))
    const first = runStartupTasks([pending], stateFile)
    const second = runStartupTasks([pending], stateFile)
    release()
    const results = await Promise.all([first, second])
    expect(pending.run).toHaveBeenCalledOnce()
    expect(results.map(result => result.completed.length)).toEqual([1, 0])
  })

  it.each(['', '{broken', '{"version":2,"tasks":[]}', '{"version":1,"tasks":[{"id":"old"}]}'])(
    'preserves invalid or unsupported state and does not execute tasks: %s', async raw => {
      writeFileSync(stateFile, raw)
      const pending = task('pending')
      await expect(runStartupTasks([pending], stateFile)).rejects.toThrow()
      expect(pending.run).not.toHaveBeenCalled()
      expect(readFileSync(stateFile, 'utf8')).toBe(raw)
    },
  )

  it('rejects duplicate task IDs before executing any task', async () => {
    const first = task('duplicate')
    await expect(runStartupTasks([first, task('duplicate')], stateFile)).rejects.toThrow('unique IDs')
    expect(first.run).not.toHaveBeenCalled()
    expect(existsSync(stateFile)).toBe(false)
  })

  it('stops if completion cannot be saved, allowing the unfinished task to retry', async () => {
    const first = task('first')
    const second = task('second')
    vi.spyOn(safeFileStore as any, 'writeTextUnlocked').mockRejectedValueOnce(new Error('disk full'))
    await expect(runStartupTasks([first, second], stateFile)).rejects.toThrow('disk full')
    expect(first.run).toHaveBeenCalledOnce()
    expect(second.run).not.toHaveBeenCalled()
    expect(existsSync(stateFile)).toBe(false)
    await runStartupTasks([first, second], stateFile)
    expect(first.run).toHaveBeenCalledTimes(2)
    expect(second.run).toHaveBeenCalledOnce()
  })
})
