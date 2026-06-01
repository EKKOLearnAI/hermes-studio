export type LlmTaskPriority = 'high' | 'medium' | 'low'

export interface LlmTaskOptions {
  priority?: LlmTaskPriority
  kind?: string
}

export interface LlmSchedulerTelemetry {
  generatedAt: string
  maxConcurrency: number
  activeCount: number
  queuedCount: number
  completedCount: number
  failedCount: number
  active: Array<{
    id: string
    kind: string
    priority: LlmTaskPriority
    startedAt: string
  }>
  queued: Array<{
    id: string
    kind: string
    priority: LlmTaskPriority
    enqueuedAt: string
  }>
  byPriority: Record<LlmTaskPriority, {
    active: number
    queued: number
  }>
}

interface QueuedLlmTask<T> {
  id: string
  kind: string
  priority: LlmTaskPriority
  sequence: number
  enqueuedAt: string
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

interface ActiveLlmTask {
  id: string
  kind: string
  priority: LlmTaskPriority
  startedAt: string
}

const PRIORITY_WEIGHT: Record<LlmTaskPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

function normalizePriority(priority: unknown): LlmTaskPriority {
  return priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium'
}

function normalizeMaxConcurrency(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 2
  return Math.max(1, Math.min(8, Math.trunc(parsed)))
}

function makeTaskId(kind: string): string {
  return `llm-${kind.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class LlmScheduler {
  private active = new Map<string, ActiveLlmTask>()
  private queue: Array<QueuedLlmTask<unknown>> = []
  private sequence = 0
  private completedCount = 0
  private failedCount = 0
  private maxConcurrency: number

  constructor(maxConcurrency = normalizeMaxConcurrency(process.env.HERMES_LLM_MAX_CONCURRENCY)) {
    this.maxConcurrency = maxConcurrency
  }

  setMaxConcurrency(maxConcurrency: number) {
    this.maxConcurrency = normalizeMaxConcurrency(maxConcurrency)
    this.pump()
  }

  schedule<T>(task: () => Promise<T>, options: LlmTaskOptions = {}): Promise<T> {
    const priority = normalizePriority(options.priority)
    const kind = String(options.kind || 'llm-request').trim() || 'llm-request'

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedLlmTask<T> = {
        id: makeTaskId(kind),
        kind,
        priority,
        sequence: this.sequence++,
        enqueuedAt: new Date().toISOString(),
        task,
        resolve,
        reject,
      }
      this.queue.push(queued as QueuedLlmTask<unknown>)
      this.sortQueue()
      this.pump()
    })
  }

  telemetry(): LlmSchedulerTelemetry {
    const active = [...this.active.values()]
    const queued = this.queue.map(task => ({
      id: task.id,
      kind: task.kind,
      priority: task.priority,
      enqueuedAt: task.enqueuedAt,
    }))
    const byPriority: LlmSchedulerTelemetry['byPriority'] = {
      high: { active: 0, queued: 0 },
      medium: { active: 0, queued: 0 },
      low: { active: 0, queued: 0 },
    }
    for (const task of active) byPriority[task.priority].active += 1
    for (const task of queued) byPriority[task.priority].queued += 1

    return {
      generatedAt: new Date().toISOString(),
      maxConcurrency: this.maxConcurrency,
      activeCount: active.length,
      queuedCount: queued.length,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      active,
      queued,
      byPriority,
    }
  }

  resetForTests() {
    this.active.clear()
    this.queue = []
    this.sequence = 0
    this.completedCount = 0
    this.failedCount = 0
  }

  private sortQueue() {
    this.queue.sort((left, right) =>
      PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority] ||
      left.sequence - right.sequence,
    )
  }

  private pump() {
    while (this.active.size < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) return
      const activeTask: ActiveLlmTask = {
        id: next.id,
        kind: next.kind,
        priority: next.priority,
        startedAt: new Date().toISOString(),
      }
      this.active.set(next.id, activeTask)
      void next.task()
        .then((value) => {
          this.completedCount += 1
          next.resolve(value)
        })
        .catch((error) => {
          this.failedCount += 1
          next.reject(error)
        })
        .finally(() => {
          this.active.delete(next.id)
          this.pump()
        })
    }
  }
}

export const llmScheduler = new LlmScheduler()

export function scheduleLlmTask<T>(task: () => Promise<T>, options: LlmTaskOptions = {}): Promise<T> {
  return llmScheduler.schedule(task, options)
}

export function getLlmSchedulerTelemetry(): LlmSchedulerTelemetry {
  return llmScheduler.telemetry()
}
