import type { Context } from 'koa'
import * as warRoom from '../../services/hermes/war-room'

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

class InvalidWarRoomRequestError extends Error {
  status = 400
}

function invalidRequest(message: string): never {
  throw new InvalidWarRoomRequestError(message)
}

function cleanProfile(value: unknown): string {
  const profile = String(value || 'default').trim() || 'default'
  if (!SAFE_NAME_RE.test(profile)) invalidRequest('invalid profile')
  return profile
}

function headerProfile(ctx: Context): string | undefined {
  const value = typeof ctx.get === 'function' ? ctx.get('X-Hermes-Profile') : ctx.headers?.['x-hermes-profile']
  return Array.isArray(value) ? value[0] : value || undefined
}

function profileFromContext(ctx: Context): string {
  return cleanProfile(ctx.query.profile || (ctx.request.body as any)?.profile || headerProfile(ctx))
}

function cleanText(value: unknown, field: string, maxLength: number, required = true): string | undefined {
  const text = String(value || '').trim()
  if (required && !text) invalidRequest(`${field} is required`)
  if (!text) return undefined
  if (text.length > maxLength) invalidRequest(`${field} is too long`)
  return text
}

function cleanOptionalSafeName(value: unknown, field: string): string | undefined {
  const text = String(value || '').trim()
  if (!text) return undefined
  if (!SAFE_NAME_RE.test(text)) invalidRequest(`invalid ${field}`)
  return text
}

function cleanTaskId(value: unknown): string {
  const taskId = String(value || '').trim()
  if (!taskId) invalidRequest('task id is required')
  if (taskId.length > 128) invalidRequest('task id is too long')
  return taskId
}

function cleanPriority(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const priority = Number(value)
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) invalidRequest('invalid priority')
  return priority
}

function handleWarRoomError(ctx: Context, err: any, fallback: string) {
  ctx.status = err instanceof InvalidWarRoomRequestError ? err.status : 500
  ctx.body = { error: err.message || fallback }
}

export async function snapshot(ctx: Context) {
  try {
    ctx.body = { snapshot: await warRoom.getSnapshot(profileFromContext(ctx)) }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to load war room snapshot')
  }
}

export async function createTask(ctx: Context) {
  const body = ctx.request.body as {
    title?: string
    body?: string
    assignee?: string
    priority?: number
    tenant?: string
  }

  try {
    const task = await warRoom.createTask({
      title: cleanText(body.title, 'title', 160)!,
      body: cleanText(body.body, 'body', 4000, false),
      assignee: cleanText(body.assignee, 'assignee', 80, false),
      priority: cleanPriority(body.priority),
      tenant: cleanOptionalSafeName(body.tenant, 'tenant'),
    })
    ctx.body = { task }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to create war room task')
  }
}

export async function handoffTask(ctx: Context) {
  const { assignee } = ctx.request.body as { assignee?: string }
  try {
    await warRoom.handoffTask(cleanTaskId(ctx.params.id), cleanText(assignee, 'assignee', 80)!)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to handoff war room task')
  }
}

export async function blockTask(ctx: Context) {
  const { reason } = ctx.request.body as { reason?: string }
  try {
    await warRoom.blockTask(cleanTaskId(ctx.params.id), cleanText(reason, 'reason', 1000)!)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to block war room task')
  }
}

export async function completeTask(ctx: Context) {
  const { summary } = ctx.request.body as { summary?: string }
  try {
    await warRoom.completeTask(cleanTaskId(ctx.params.id), cleanText(summary, 'summary', 2000)!)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to complete war room task')
  }
}

export async function evidence(ctx: Context) {
  try {
    const evidence = await warRoom.getEvidence(cleanTaskId(ctx.params.id))
    if (!evidence) {
      ctx.status = 404
      ctx.body = { error: 'Task not found' }
      return
    }
    ctx.body = { evidence }
  } catch (err: any) {
    handleWarRoomError(ctx, err, 'Failed to load war room evidence')
  }
}
