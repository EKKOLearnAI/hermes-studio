import type { Context } from 'koa'
import { readFile } from 'fs/promises'
import { resolve, normalize } from 'path'
import { homedir } from 'os'
import * as kanbanCli from '../../services/hermes/hermes-kanban'
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

function requestBoard(ctx: Context): string | null {
  const rawBoard = firstQueryValue(ctx.query.board as string | string[] | undefined)
  if (rawBoard !== undefined && !rawBoard.trim()) {
    ctx.status = 400
    ctx.body = { error: 'invalid board slug' }
    return null
  }
  try {
    return kanbanCli.normalizeBoardSlug(rawBoard)
  } catch {
    ctx.status = 400
    ctx.body = { error: 'invalid board slug' }
    return null
  }
}

function validSeverity(value?: string): value is 'warning' | 'error' | 'critical' {
  return value === undefined || value === 'warning' || value === 'error' || value === 'critical'
}

const MAX_LOG_TAIL_BYTES = 1_000_000
const MAX_DISPATCH_TASKS = 100
const MAX_DISPATCH_FAILURE_LIMIT = 100
const MAX_BULK_TASKS = 100

type PositiveIntegerResult = { value?: number; error?: string }
type StringResult = { value?: string; error?: string }
type BooleanResult = { value?: boolean; error?: string }
type BodyResult = { body: Record<string, unknown>; error?: string }

function optionalPositiveInteger(value: unknown, name: string, max: number): PositiveIntegerResult {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { error: `${name} must be a positive integer` }
  }
  if (value > max) {
    return { error: `${name} must be <= ${max}` }
  }
  return { value }
}

function optionalPositiveIntegerQuery(value: string | undefined, name: string, max: number): PositiveIntegerResult {
  if (value === undefined || value === '') return {}
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { error: `${name} must be a positive integer` }
  }
  if (numeric > max) {
    return { error: `${name} must be <= ${max}` }
  }
  return { value: numeric }
}

function requestBody(ctx: Context): BodyResult {
  const body = ctx.request.body
  if (body === undefined || body === null) return { body: {} }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { body: {}, error: 'request body must be an object' }
  }
  return { body: body as Record<string, unknown> }
}

function optionalString(value: unknown, name: string): StringResult {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'string') return { error: `${name} must be a string` }
  return { value }
}

function optionalNullableString(value: unknown, name: string): { value?: string | null; error?: string } {
  if (value === undefined) return {}
  if (value === null) return { value: null }
  if (typeof value !== 'string') return { error: `${name} must be a string` }
  return { value }
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function optionalTaskStatus(value: unknown, name: string): { value?: kanbanCli.KanbanTaskStatus; error?: string } {
  if (value === undefined || value === null) return {}
  if (value !== 'triage' && value !== 'todo' && value !== 'ready' && value !== 'running' && value !== 'blocked' && value !== 'done' && value !== 'archived') {
    return { error: `${name} must be a valid kanban task status` }
  }
  return { value }
}

function requiredNonEmptyString(value: unknown, name: string): StringResult {
  if (typeof value !== 'string' || !value.trim()) return { error: `${name} is required` }
  return { value }
}

function requiredNonEmptyStringArray(value: unknown, name: string): { value?: string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    return { error: `${name} is required` }
  }
  return { value }
}

function optionalBoolean(value: unknown, name: string): BooleanResult {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'boolean') return { error: `${name} must be boolean` }
  return { value }
}

function optionalInteger(value: unknown, name: string): PositiveIntegerResult {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { error: `${name} must be an integer` }
  }
  return { value }
}

function rejectBadRequest(ctx: Context, error?: string): boolean {
  if (!error) return false
  ctx.status = 400
  ctx.body = { error }
  return true
}

export async function listBoards(ctx: Context) {
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
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const slug = requiredNonEmptyString(body.slug, 'slug')
  const name = optionalString(body.name, 'name')
  const description = optionalString(body.description, 'description')
  const icon = optionalString(body.icon, 'icon')
  const color = optionalString(body.color, 'color')
  const switchCurrent = optionalBoolean(body.switchCurrent, 'switchCurrent')
  if (rejectBadRequest(ctx, slug.error || name.error || description.error || icon.error || color.error || switchCurrent.error)) return
  try {
    const board = await kanbanCli.createBoard({
      slug: slug.value!,
      name: name.value,
      description: description.value,
      icon: icon.value,
      color: color.value,
      switchCurrent: switchCurrent.value,
    })
    ctx.body = { board }
  } catch (err: any) {
    ctx.status = err.message?.includes('Invalid kanban board slug') ? 400 : 500
    ctx.body = { error: err.message }
  }
}

export async function archiveBoard(ctx: Context) {
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
  try {
    const capabilities = await kanbanCli.getCapabilities()
    ctx.body = { capabilities }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function list(ctx: Context) {
  const status = firstQueryValue(ctx.query.status as string | string[] | undefined)
  const assignee = firstQueryValue(ctx.query.assignee as string | string[] | undefined)
  const tenant = firstQueryValue(ctx.query.tenant as string | string[] | undefined)
  const includeArchived = firstQueryValue(ctx.query.includeArchived as string | string[] | undefined) === 'true'
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const tasks = await kanbanCli.listTasks({ board, status, assignee, tenant, includeArchived })
    ctx.body = { tasks }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: Context) {
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const detail = await kanbanCli.getTask(ctx.params.id, { board })
    if (!detail) {
      ctx.status = 404
      ctx.body = { error: 'Task not found' }
      return
    }

    // For terminal tasks, find related session from the worker's profile DB.
    // Archived tasks can still carry the worker result/session users need to inspect.
    if ((detail.task.status === 'done' || detail.task.status === 'archived') && detail.runs.length > 0) {
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
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const payload = bodyResult.body
  const title = requiredNonEmptyString(payload.title, 'title')
  const body = optionalString(payload.body, 'body')
  const assignee = optionalString(payload.assignee, 'assignee')
  const priority = optionalInteger(payload.priority, 'priority')
  const tenant = optionalString(payload.tenant, 'tenant')
  if (rejectBadRequest(ctx, title.error || body.error || assignee.error || priority.error || tenant.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const task = await kanbanCli.createTask(title.value!, { board, body: body.value, assignee: assignee.value, priority: priority.value, tenant: tenant.value })
    ctx.body = { task }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function complete(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const payload = bodyResult.body
  const taskIds = requiredNonEmptyStringArray(payload.task_ids, 'task_ids')
  const summary = optionalString(payload.summary, 'summary')
  if (rejectBadRequest(ctx, taskIds.error || summary.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    await kanbanCli.completeTasks(taskIds.value!, summary.value, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function block(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const reason = requiredNonEmptyString(bodyResult.body.reason, 'reason')
  if (rejectBadRequest(ctx, reason.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    await kanbanCli.blockTask(ctx.params.id, reason.value!, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function unblock(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const taskIds = requiredNonEmptyStringArray(bodyResult.body.task_ids, 'task_ids')
  if (rejectBadRequest(ctx, taskIds.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    await kanbanCli.unblockTasks(taskIds.value!, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function assign(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const profile = requiredNonEmptyString(bodyResult.body.profile, 'profile')
  if (rejectBadRequest(ctx, profile.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    await kanbanCli.assignTask(ctx.params.id, profile.value!, { board })
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function addComment(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const bodyPayload = bodyResult.body
  const body = requiredNonEmptyString(bodyPayload.body, 'body')
  const author = optionalString(bodyPayload.author, 'author')
  if (rejectBadRequest(ctx, body.error || author.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.addComment(ctx.params.id, body.value!, { board, author: author.value })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function linkTasks(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const parentId = requiredNonEmptyString(bodyResult.body.parent_id, 'parent_id')
  const childId = requiredNonEmptyString(bodyResult.body.child_id, 'child_id')
  if (rejectBadRequest(ctx, parentId.error || childId.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.linkTasks(parentId.value!.trim(), childId.value!.trim(), { board })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function unlinkTasks(ctx: Context) {
  const parentId = requiredNonEmptyString(firstQueryValue(ctx.query.parent_id as string | string[] | undefined), 'parent_id')
  const childId = requiredNonEmptyString(firstQueryValue(ctx.query.child_id as string | string[] | undefined), 'child_id')
  if (rejectBadRequest(ctx, parentId.error || childId.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.unlinkTasks(parentId.value!.trim(), childId.value!.trim(), { board })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function bulkUpdateTasks(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const ids = requiredNonEmptyStringArray(body.ids, 'ids')
  const status = optionalTaskStatus(body.status, 'status')
  const assignee = optionalNullableString(body.assignee, 'assignee')
  const archive = optionalBoolean(body.archive, 'archive')
  const summary = optionalString(body.summary, 'summary')
  const reason = optionalString(body.reason, 'reason')
  if (rejectBadRequest(ctx, ids.error || status.error || assignee.error || archive.error || summary.error || reason.error)) return
  if (!archive.value && status.value === undefined && !hasOwn(body, 'assignee')) {
    ctx.status = 400
    ctx.body = { error: 'at least one bulk action is required' }
    return
  }
  if (ids.value!.length > MAX_BULK_TASKS) {
    ctx.status = 400
    ctx.body = { error: `ids must contain <= ${MAX_BULK_TASKS} tasks` }
    return
  }
  if (archive.value && status.value !== undefined) {
    ctx.status = 400
    ctx.body = { error: 'archive cannot be combined with status' }
    return
  }
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.bulkUpdateTasks({
      board,
      ids: ids.value!.map(id => id.trim()),
      status: status.value,
      assignee: assignee.value,
      archive: archive.value,
      summary: summary.value,
      reason: reason.value,
    })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function taskLog(ctx: Context) {
  const board = requestBoard(ctx)
  if (!board) return
  const tailRaw = firstQueryValue(ctx.query.tail as string | string[] | undefined)
  const tail = optionalPositiveIntegerQuery(tailRaw, 'tail', MAX_LOG_TAIL_BYTES)
  if (rejectBadRequest(ctx, tail.error)) return
  try {
    ctx.body = await kanbanCli.getTaskLog(ctx.params.id, { board, tail: tail.value })
  } catch (err: any) {
    ctx.status = err.message?.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
}

export async function diagnostics(ctx: Context) {
  const board = requestBoard(ctx)
  if (!board) return
  const task = firstQueryValue(ctx.query.task as string | string[] | undefined)
  const severity = firstQueryValue(ctx.query.severity as string | string[] | undefined)
  if (!validSeverity(severity)) {
    ctx.status = 400
    ctx.body = { error: 'severity must be warning, error, or critical' }
    return
  }
  try {
    const diagnostics = await kanbanCli.getDiagnostics({ board, task, severity })
    ctx.body = { diagnostics }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function reclaim(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const reason = optionalString(body.reason, 'reason')
  if (rejectBadRequest(ctx, reason.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.reclaimTask(ctx.params.id, { board, reason: reason.value })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function reassign(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const profile = requiredNonEmptyString(body.profile, 'profile')
  const reclaim = optionalBoolean(body.reclaim, 'reclaim')
  const reason = optionalString(body.reason, 'reason')
  if (rejectBadRequest(ctx, profile.error || reclaim.error || reason.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    ctx.body = await kanbanCli.reassignTask(ctx.params.id, profile.value!, { board, reclaim: reclaim.value, reason: reason.value })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function specify(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const author = optionalString(body.author, 'author')
  if (rejectBadRequest(ctx, author.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const results = await kanbanCli.specifyTask(ctx.params.id, { board, author: author.value })
    ctx.body = { results }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function dispatch(ctx: Context) {
  const bodyResult = requestBody(ctx)
  if (rejectBadRequest(ctx, bodyResult.error)) return
  const body = bodyResult.body
  const dryRun = optionalBoolean(body.dryRun, 'dryRun')
  const max = optionalPositiveInteger(body.max, 'max', MAX_DISPATCH_TASKS)
  const failureLimit = optionalPositiveInteger(body.failureLimit, 'failureLimit', MAX_DISPATCH_FAILURE_LIMIT)
  if (rejectBadRequest(ctx, dryRun.error || max.error || failureLimit.error)) return
  const board = requestBoard(ctx)
  if (!board) return
  try {
    const result = await kanbanCli.dispatch({ board, dryRun: dryRun.value, max: max.value, failureLimit: failureLimit.value })
    ctx.body = { result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function stats(ctx: Context) {
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
  const filePath = ctx.query.path as string | undefined
  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'path is required' }
    return
  }

  const kanbanDir = resolve(homedir(), '.hermes', 'kanban', 'workspaces')
  const resolved = resolve(normalize(filePath))

  if (!resolved.startsWith(kanbanDir)) {
    ctx.status = 403
    ctx.body = { error: 'Path must be within kanban workspaces' }
    return
  }

  try {
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
