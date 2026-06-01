import { describe, expect, it } from 'vitest'
import { LlmScheduler } from '../../packages/server/src/services/hermes/llm-scheduler'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('Hermes LLM scheduler', () => {
  it('runs high priority active simulations before queued low priority background tasks', async () => {
    const scheduler = new LlmScheduler(1)
    const startOrder: string[] = []
    const lowA = deferred<string>()
    const lowB = deferred<string>()
    const high = deferred<string>()

    const lowAPromise = scheduler.schedule(async () => {
      startOrder.push('low-a')
      return lowA.promise
    }, { priority: 'low', kind: 'background-memory' })
    const lowBPromise = scheduler.schedule(async () => {
      startOrder.push('low-b')
      return lowB.promise
    }, { priority: 'low', kind: 'background-memory' })
    const highPromise = scheduler.schedule(async () => {
      startOrder.push('high')
      return high.promise
    }, { priority: 'high', kind: 'mirofish-active-debate' })

    expect(startOrder).toEqual(['low-a'])
    expect(scheduler.telemetry()).toMatchObject({
      activeCount: 1,
      queuedCount: 2,
      byPriority: {
        high: { queued: 1 },
        low: { active: 1, queued: 1 },
      },
    })

    lowA.resolve('low-a-done')
    await lowAPromise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startOrder).toEqual(['low-a', 'high'])

    high.resolve('high-done')
    await highPromise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startOrder).toEqual(['low-a', 'high', 'low-b'])

    lowB.resolve('low-b-done')
    await lowBPromise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(scheduler.telemetry()).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      completedCount: 3,
    })
  })
})
