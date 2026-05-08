import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

const execOpts = { windowsHide: true }

function resolveHermesBin(): string {
  const envBin = process.env.HERMES_BIN?.trim()
  if (envBin) return envBin
  return 'hermes'
}

const HERMES_BIN = resolveHermesBin()

// ─── Types ──────────────────────────────────────────────────────

export type KanbanTaskStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'archived'

export interface KanbanTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: KanbanTaskStatus
  priority: number
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  workspace_kind: string
  workspace_path: string | null
  tenant: string | null
  result: string | null
  skills: string[] | null
}

export interface KanbanRun {
  id: number
  task_id: string
  profile: string | null
  status: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  summary: string | null
  error: string | null
}

export interface KanbanComment {
  id: number
  task_id: string
  author: string
  body: string
  created_at: number
}

export interface KanbanEvent {
  id: number
  task_id: string
  kind: string
  payload: Record<string, unknown> | null
  created_at: number
  run_id: number | null
}

export interface KanbanTaskDetail {
  task: KanbanTask
  comments: KanbanComment[]
  events: KanbanEvent[]
  runs: KanbanRun[]
}

export interface KanbanStats {
  by_status: Record<string, number>
  by_assignee: Record<string, number>
  total: number
}

export interface KanbanAssignee {
  name: string
  on_disk: boolean
  counts: Record<string, number> | null
}

// ─── CLI wrappers ───────────────────────────────────────────────

export async function listTasks(opts?: {
  status?: string
  assignee?: string
  tenant?: string
}): Promise<KanbanTask[]> {
  const args = ['kanban', 'list', '--json']
  if (opts?.status) args.push('--status', opts.status)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  if (opts?.tenant) args.push('--tenant', opts.tenant)

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban list failed')
    throw new Error(`Failed to list kanban tasks: ${err.message}`)
  }
}

export async function getTask(taskId: string): Promise<KanbanTaskDetail | null> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['kanban', 'show', taskId, '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    if (err.code === 1 || err.status === 1) return null
    logger.error(err, 'Hermes CLI: kanban show failed')
    throw new Error(`Failed to get kanban task: ${err.message}`)
  }
}

export async function createTask(
  title: string,
  opts?: {
    body?: string
    assignee?: string
    priority?: number
    tenant?: string
  },
): Promise<KanbanTask> {
  const args = ['kanban', 'create', title, '--json']
  if (opts?.body) args.push('--body', opts.body)
  if (opts?.assignee) args.push('--assignee', opts.assignee)
  if (opts?.priority !== undefined) args.push('--priority', String(opts.priority))
  if (opts?.tenant) args.push('--tenant', opts.tenant)

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban create failed')
    throw new Error(`Failed to create kanban task: ${err.message}`)
  }
}

export async function completeTasks(taskIds: string[], summary?: string): Promise<void> {
  const args = ['kanban', 'complete', ...taskIds]
  if (summary) args.push('--summary', summary)

  try {
    await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban complete failed')
    throw new Error(`Failed to complete kanban tasks: ${err.message}`)
  }
}

export async function blockTask(taskId: string, reason: string): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, ['kanban', 'block', taskId, reason], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban block failed')
    throw new Error(`Failed to block kanban task: ${err.message}`)
  }
}

export async function unblockTasks(taskIds: string[]): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, ['kanban', 'unblock', ...taskIds], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban unblock failed')
    throw new Error(`Failed to unblock kanban tasks: ${err.message}`)
  }
}

export async function assignTask(taskId: string, profile: string): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, ['kanban', 'assign', taskId, profile], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban assign failed')
    throw new Error(`Failed to assign kanban task: ${err.message}`)
  }
}

export async function getStats(): Promise<KanbanStats> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['kanban', 'stats', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban stats failed')
    throw new Error(`Failed to get kanban stats: ${err.message}`)
  }
}

export async function getAssignees(): Promise<KanbanAssignee[]> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, ['kanban', 'assignees', '--json'], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban assignees failed')
    throw new Error(`Failed to get kanban assignees: ${err.message}`)
  }
}
