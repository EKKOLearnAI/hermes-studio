import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

const execOpts = { windowsHide: true }
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

function resolveHermesBin(): string {
  const envBin = process.env.HERMES_BIN?.trim()
  if (envBin) return envBin
  return 'hermes'
}

const HERMES_BIN = resolveHermesBin()

export function normalizeBoardSlug(board?: string | null): string {
  const trimmed = board?.trim()
  if (!trimmed) return 'default'
  if (!BOARD_SLUG_RE.test(trimmed)) {
    throw new Error('Invalid kanban board slug')
  }
  return trimmed
}

function boardArgs(board?: string | null): string[] {
  return ['kanban', '--board', normalizeBoardSlug(board)]
}

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

export interface KanbanBoard {
  slug: string
  name: string
  description: string
  icon: string
  color: string
  created_at: number | null
  archived: boolean
  db_path?: string
  is_current?: boolean
  counts: Record<string, number>
  total: number
}

export interface KanbanBoardCreateOptions {
  slug: string
  name?: string
  description?: string
  icon?: string
  color?: string
  switchCurrent?: boolean
}

export interface KanbanCapabilities {
  source: 'hermes-cli'
  supports: Record<string, boolean>
  missing: string[]
}

export interface KanbanBoardOptions {
  board?: string
}

// ─── CLI wrappers ───────────────────────────────────────────────

export async function listBoards(opts?: { includeArchived?: boolean }): Promise<KanbanBoard[]> {
  const args = ['kanban', 'boards', 'list', '--json']
  if (opts?.includeArchived) args.push('--all')

  try {
    const { stdout } = await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    return JSON.parse(stdout)
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards list failed')
    throw new Error(`Failed to list kanban boards: ${err.message}`)
  }
}

async function findBoard(slug: string, includeArchived = true): Promise<KanbanBoard | null> {
  const boards = await listBoards({ includeArchived })
  return boards.find(board => board.slug === slug) || null
}

export async function createBoard(opts: KanbanBoardCreateOptions): Promise<KanbanBoard> {
  const slug = normalizeBoardSlug(opts.slug)
  const args = ['kanban', 'boards', 'create', slug]
  if (opts.name?.trim()) args.push('--name', opts.name.trim())
  if (opts.description?.trim()) args.push('--description', opts.description.trim())
  if (opts.icon?.trim()) args.push('--icon', opts.icon.trim())
  if (opts.color?.trim()) args.push('--color', opts.color.trim())
  if (opts.switchCurrent) args.push('--switch')

  try {
    await execFileAsync(HERMES_BIN, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
    const board = await findBoard(slug)
    if (!board) throw new Error('created board was not returned by boards list')
    return board
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards create failed')
    throw new Error(`Failed to create kanban board: ${err.message}`)
  }
}

export async function archiveBoard(slugInput: string): Promise<void> {
  const slug = normalizeBoardSlug(slugInput)
  if (slug === 'default') throw new Error('Cannot archive the default kanban board')

  try {
    await execFileAsync(HERMES_BIN, ['kanban', 'boards', 'rm', slug], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban boards archive failed')
    throw new Error(`Failed to archive kanban board: ${err.message}`)
  }
}

export async function getCapabilities(): Promise<KanbanCapabilities> {
  const supports = {
    explicitBoard: true,
    boardsList: true,
    boardCreate: true,
    boardArchive: true,
    cliCurrentSwitch: true,
    taskCrudLite: true,
    commentsWrite: false,
    taskLog: false,
    dispatch: false,
    events: false,
    diagnostics: false,
    bulk: false,
  }
  const missing = Object.entries(supports)
    .filter(([, supported]) => !supported)
    .map(([name]) => name)
  return { source: 'hermes-cli', supports, missing }
}

export async function listTasks(opts?: {
  board?: string
  status?: string
  assignee?: string
  tenant?: string
}): Promise<KanbanTask[]> {
  const args = [...boardArgs(opts?.board), 'list', '--json']
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

export async function getTask(taskId: string, opts?: KanbanBoardOptions): Promise<KanbanTaskDetail | null> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'show', taskId, '--json'], {
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
    board?: string
    body?: string
    assignee?: string
    priority?: number
    tenant?: string
  },
): Promise<KanbanTask> {
  const args = [...boardArgs(opts?.board), 'create', title, '--json']
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

export async function completeTasks(taskIds: string[], summary?: string, opts?: KanbanBoardOptions): Promise<void> {
  const args = [...boardArgs(opts?.board), 'complete', ...taskIds]
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

export async function blockTask(taskId: string, reason: string, opts?: KanbanBoardOptions): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'block', taskId, reason], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban block failed')
    throw new Error(`Failed to block kanban task: ${err.message}`)
  }
}

export async function unblockTasks(taskIds: string[], opts?: KanbanBoardOptions): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'unblock', ...taskIds], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban unblock failed')
    throw new Error(`Failed to unblock kanban tasks: ${err.message}`)
  }
}

export async function assignTask(taskId: string, profile: string, opts?: KanbanBoardOptions): Promise<void> {
  try {
    await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'assign', taskId, profile], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      ...execOpts,
    })
  } catch (err: any) {
    logger.error(err, 'Hermes CLI: kanban assign failed')
    throw new Error(`Failed to assign kanban task: ${err.message}`)
  }
}

export async function getStats(opts?: KanbanBoardOptions): Promise<KanbanStats> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'stats', '--json'], {
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

export async function getAssignees(opts?: KanbanBoardOptions): Promise<KanbanAssignee[]> {
  try {
    const { stdout } = await execFileAsync(HERMES_BIN, [...boardArgs(opts?.board), 'assignees', '--json'], {
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
