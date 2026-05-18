import type { Context } from 'koa'
import { readFile } from 'fs/promises'
import { isAbsolute, relative, resolve, normalize } from 'path'
import { homedir } from 'os'
import * as kanbanCli from '../../services/hermes/hermes-kanban'
import { ownerOwnsProfile } from '../../services/hermes/agent-ownership'
import {
  searchSessionSummariesWithProfile,
  getSessionDetailFromDbWithProfile,
  getExactSessionDetailFromDbWithProfile,
  findLatestExactSessionIdWithProfile,
} from '../../db/hermes/sessions-db'

function getLatestRunProfile(detail: { runs: Array<{ profile: string | null }> }): string | null {
  return [...detail.runs].reverse().find(run => run.profile)?.profile || null
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function requireOpenId(ctx: Context): string | null {
  const user = ctx.state.user as { openid?: string } | undefined
  if (!user?.openid) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  return user.openid
}

// Per-request memoized ownership check so a multi-task list opens the
// multitenancy DB at most once per distinct profile, not once per task.
function makeOwnershipCache(openid: string): (profile: string | null | undefined) => boolean {
  const cache = new Map<string, boolean>()
  return (profile) => {
    if (!profile || !profile.trim()) return false
    const key = profile.trim()
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const owned = ownerOwnsProfile(openid, key)
    cache.set(key, owned)
    return owned
  }
}

// A task is visible to openid when it owns the agent profile that the task
// is attributed to. Prefer the stronger created_by signal when the CLI
// populated it; otherwise fall back to the assignee↔owned-agent mapping.
function taskOwnedBy(task: { assignee: string | null; created_by?: string | null; tenant?: string | null }, isOwned: (p: string | null | undefined) => boolean, openid: string): boolean {
  if (task.created_by && task.created_by.trim()) return isOwned(task.created_by)
  if (task.assignee && task.assignee.trim()) return isOwned(task.assignee)
  return task.tenant === openid
}

async function getOwnedTaskDetail(
  ctx: Context,
  taskId: string,
  board: string,
  openid: string,
): Promise<kanbanCli.KanbanTaskDetail | null> {
  const detail = await kanbanCli.getTask(taskId, { board })
  const isOwned = makeOwnershipCache(openid)
  if (!detail || !taskOwnedBy(detail.task, isOwned, openid)) {
    ctx.status = 404
    ctx.body = { error: 'Task not found' }
    return null
  }
  return detail
}

async function requireOwnedTasks(ctx: Context, taskIds: string[], board: string, openid: string): Promise<boolean> {
  const isOwned = makeOwnershipCache(openid)
  // Fail closed for the whole write batch so a missing or unowned id cannot slip through via partial success semantics.
  for (const taskId of taskIds) {
    const detail = await kanbanCli.getTask(taskId, { board })
    if (!detail || !taskOwnedBy(detail.task, isOwned, openid)) {
      ctx.status = 403
      ctx.body = { error: 'You do not own one or more of these tasks' }
      return false
    }
  }
  return true
}

function inferTaskIdFromArtifactPath(resolvedPath: string, kanbanDir: string): string | null {
  const rel = relative(kanbanDir, resolvedPath)
  if (!rel || rel.startsWith('..') || rel === '.' || isAbsolute(rel)) return null
  const first = rel.split(/[\\/]/)[0]?.trim()
  return first || null
}

function pathInsideDir(resolvedPath: string, dir: string): boolean {
  const rel = relative(dir, resolvedPath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function requestBoard(ctx: Context): string | null {
  try {
    return kanbanCli.normalizeBoardSlug(firstQueryValue(ctx.query.board as string | string[] | undefined))
  } catch {
    ctx.status = 400
    ctx.body = { error: 'invalid board slug' }
    return null
  }
}

export async function listBoards(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const includeArchived = firstQueryValue(ctx.query.includeArchived as string | string[] | undefined) === 'true'
  try {
    const boards = await kanbanCli.listBoards({ includeArchived })
    ctx.body = { boards }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function createBoard(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { slug, name, description, icon, color, switchCurrent } = ctx.request.body as {
    slug?: string
    name?: string
    description?: string
    icon?: string
    color?: string
    switchCurrent?: boolean
  }
  if (!slug?.trim()) {
    ctx.status = 400
    ctx.body = { error: 'slug is required' }
    return
  }
  try {
    const board = await kanbanCli.createBoard({ slug, name, description, icon, color, switchCurrent })
    ctx.body = { board }
  } catch (err: any) {
    ctx.status = err.message?.includes('Invalid kanban board slug') ? 400 : 500
    ctx.body = { error: err.message }
  }
}

export async function archiveBoard(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const slug = ctx.params.slug
  if (!slug?.trim()) {
    ctx.status = 400
    ctx.body = { error: 'slug is required' }
    return
  }
  try {
    await kanbanCli.archiveBoard(slug)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = err.message?.includes('default') || err.message?.includes('Invalid kanban board slug') ? 400 : 500
    ctx.body = { error: err.message }
  }
}

export async function capabilities(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  try {
    const capabilities = await kanbanCli.getCapabilities()
    ctx.body = { capabilities }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function list(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { status, assignee, tenant } = ctx.query as Record<string, string | undefined>
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const tasks = await kanbanCli.listTasks({ board, status, assignee, tenant })
    const isOwned = makeOwnershipCache(openid)
    ctx.body = { tasks: tasks.filter(task => taskOwnedBy(task, isOwned, openid)) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const detail = await kanbanCli.getTask(ctx.params.id, { board })
    if (!detail) {
      ctx.status = 404
      ctx.body = { error: 'Task not found' }
      return
    }
    const isOwned = makeOwnershipCache(openid)
    if (!taskOwnedBy(detail.task, isOwned, openid)) {
      ctx.status = 404
      ctx.body = { error: 'Task not found' }
      return
    }

    // For completed tasks, find related session from the worker's profile DB
    if (detail.task.status === 'done' && detail.runs.length > 0) {
      const profile = getLatestRunProfile(detail)
      if (profile) {
        try {
          const exactSessionId = await findLatestExactSessionIdWithProfile(detail.task.id, profile)
          if (exactSessionId) {
            const sessionDetail = await getExactSessionDetailFromDbWithProfile(exactSessionId, profile)
            if (sessionDetail) {
              ;(detail as any).session = {
                id: exactSessionId,
                title: sessionDetail.title,
                source: sessionDetail.source,
                model: sessionDetail.model,
                started_at: sessionDetail.started_at,
                ended_at: sessionDetail.ended_at,
                messages: sessionDetail.messages,
              }
            }
          } else {
            const results = await searchSessionSummariesWithProfile(detail.task.id, profile, undefined, 5)
            if (results.length > 0) {
              const sessionId = results[0].id
              const sessionDetail = await getSessionDetailFromDbWithProfile(sessionId, profile)
              if (sessionDetail) {
                ;(detail as any).session = {
                  id: sessionId,
                  title: sessionDetail.title,
                  source: sessionDetail.source,
                  model: sessionDetail.model,
                  started_at: sessionDetail.started_at,
                  ended_at: sessionDetail.ended_at,
                  messages: sessionDetail.messages,
                }
              }
            }
          }
        } catch {
          // Session lookup is best-effort, don't fail the whole request
        }
      }
    }

    ctx.body = detail
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function create(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { title, body, assignee, priority, tenant } = ctx.request.body as {
    title?: string
    body?: string
    assignee?: string
    priority?: number
    tenant?: string
  }
  if (!title) {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    if (tenant && tenant !== openid) {
      ctx.status = 403
      ctx.body = { error: 'You cannot create tasks for another tenant' }
      return
    }
    if (assignee && !ownerOwnsProfile(openid, assignee)) {
      ctx.status = 403
      ctx.body = { error: 'You do not own this agent profile' }
      return
    }
    const effectiveTenant = tenant ?? openid
    const task = await kanbanCli.createTask(title, { board, body, assignee, priority, tenant: effectiveTenant })
    ctx.body = { task }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function complete(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { task_ids, summary } = ctx.request.body as {
    task_ids?: string[]
    summary?: string
  }
  if (!task_ids?.length) {
    ctx.status = 400
    ctx.body = { error: 'task_ids is required' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    if (!await requireOwnedTasks(ctx, task_ids, board, openid)) return
    await kanbanCli.completeTasks(task_ids, summary, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function block(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { reason } = ctx.request.body as { reason?: string }
  if (!reason) {
    ctx.status = 400
    ctx.body = { error: 'reason is required' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    if (!await requireOwnedTasks(ctx, [ctx.params.id], board, openid)) return
    await kanbanCli.blockTask(ctx.params.id, reason, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function unblock(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { task_ids } = ctx.request.body as { task_ids?: string[] }
  if (!task_ids?.length) {
    ctx.status = 400
    ctx.body = { error: 'task_ids is required' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    if (!await requireOwnedTasks(ctx, task_ids, board, openid)) return
    await kanbanCli.unblockTasks(task_ids, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function assign(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { profile } = ctx.request.body as { profile?: string }
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'profile is required' }
    return
  }
  if (!ownerOwnsProfile(openid, profile)) {
    ctx.status = 403
    ctx.body = { error: 'You do not own this agent profile' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    await kanbanCli.assignTask(ctx.params.id, profile, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function stats(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const stats = await kanbanCli.getStats({ board })
    ctx.body = { stats }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function assignees(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const assignees = await kanbanCli.getAssignees({ board })
    ctx.body = { assignees }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readArtifact(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const filePath = ctx.query.path as string | undefined
  const taskIdQuery = firstQueryValue(ctx.query.task_id as string | string[] | undefined)
  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'path is required' }
    return
  }

  const kanbanDir = resolve(homedir(), '.hermes', 'kanban', 'workspaces')
  const resolved = resolve(normalize(filePath))

  if (!pathInsideDir(resolved, kanbanDir)) {
    ctx.status = 403
    ctx.body = { error: 'Path must be within kanban workspaces' }
    return
  }

  try {
    const board = requestBoard(ctx)
    if (!board) return
    const taskId = taskIdQuery?.trim() || inferTaskIdFromArtifactPath(resolved, kanbanDir)
    if (!taskId || !await getOwnedTaskDetail(ctx, taskId, board, openid)) return
    const data = await readFile(resolved, 'utf-8')
    ctx.body = { content: data, path: filePath }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      ctx.status = 404
      ctx.body = { error: 'File not found' }
    } else {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
  }
}

export async function searchSessions(ctx: Context) {
  const openid = requireOpenId(ctx)
  if (!openid) return
  const { task_id, profile, q } = ctx.query as {
    task_id?: string
    profile?: string
    q?: string
  }
  if (!task_id || !profile) {
    ctx.status = 400
    ctx.body = { error: 'task_id and profile are required' }
    return
  }
  if (!ownerOwnsProfile(openid, profile)) {
    ctx.status = 403
    ctx.body = { error: 'You do not own this agent profile' }
    return
  }
  try {
    if (!q) {
      const exactSessionId = await findLatestExactSessionIdWithProfile(task_id, profile)
      if (exactSessionId) {
        const sessionDetail = await getExactSessionDetailFromDbWithProfile(exactSessionId, profile)
        if (sessionDetail) {
          ctx.body = {
            results: [{
              id: exactSessionId,
              source: sessionDetail.source,
              title: sessionDetail.title,
              preview: sessionDetail.preview,
              model: sessionDetail.model,
              started_at: sessionDetail.started_at,
              ended_at: sessionDetail.ended_at,
              last_active: sessionDetail.last_active,
              message_count: sessionDetail.message_count,
              tool_call_count: sessionDetail.tool_call_count,
              input_tokens: sessionDetail.input_tokens,
              output_tokens: sessionDetail.output_tokens,
              cache_read_tokens: sessionDetail.cache_read_tokens,
              cache_write_tokens: sessionDetail.cache_write_tokens,
              reasoning_tokens: sessionDetail.reasoning_tokens,
              billing_provider: sessionDetail.billing_provider,
              estimated_cost_usd: sessionDetail.estimated_cost_usd,
              actual_cost_usd: sessionDetail.actual_cost_usd,
              cost_status: sessionDetail.cost_status,
              matched_message_id: null,
              snippet: sessionDetail.preview,
              rank: 0,
            }],
          }
          return
        }
      }
    }

    const searchQuery = q || task_id
    const results = await searchSessionSummariesWithProfile(searchQuery, profile, undefined, 10)
    ctx.body = { results }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
