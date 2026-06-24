import type { Context } from 'koa'
import { getWorkflowManager, type WorkflowRunNowInput, type WorkflowUpdateInput } from '../../services/workflow-manager'
import { listUserProfiles } from '../../db/hermes/users-store'
import { listWorkflowRunNodeSessions, listWorkflowRuns } from '../../db/hermes/workflow-run-store'
import { logger } from '../../services/logger'

const MAX_BATCH_DELETE = 200

function bodyRecord(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function profileName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default'
}

function requestedProfile(ctx: Context, body?: Record<string, unknown>): string | null {
  const bodyProfile = body && typeof body.profile === 'string' ? body.profile.trim() : ''
  const queryProfile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  const stateProfile = ctx.state?.profile?.name || ''
  return stateProfile || bodyProfile || queryProfile || null
}

function explicitListProfile(ctx: Context): string | null {
  const profile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  return profile || null
}

function allowedProfileSet(ctx: Context): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(ctx: Context, profile: string | null | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  return !allowed || allowed.has(profileName(profile))
}

function denyProfileAccess(ctx: Context, profile: string | null | undefined): boolean {
  if (canAccessProfile(ctx, profile)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${profileName(profile)}" is not available for this user` }
  return true
}

function filterByAllowedProfiles<T extends { profile: string }>(ctx: Context, items: T[]): T[] {
  const allowed = allowedProfileSet(ctx)
  if (!allowed) return items
  return items.filter(item => allowed.has(profileName(item.profile)))
}

function requiredId(ctx: Context): string | null {
  const id = typeof ctx.params?.id === 'string' ? ctx.params.id.trim() : ''
  if (id) return id
  ctx.status = 400
  ctx.body = { error: 'id is required' }
  return null
}

function optionalJsonArray(value: unknown, name: string): { value?: unknown[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  return { value }
}

function optionalNullableString(value: unknown, name: string): { value?: string | null; error?: string } {
  if (value === undefined) return {}
  if (value === null) return { value: null }
  if (typeof value !== 'string') return { error: `${name} must be a string` }
  return { value }
}

function optionalJsonObject(value: unknown, name: string): { value?: Record<string, unknown> | null; error?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return { error: `${name} must be an object` }
  return { value: value as Record<string, unknown> }
}

function optionalStringArray(value: unknown, name: string): { value?: string[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  const strings = value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  return { value: strings }
}

function rejectBadRequest(ctx: Context, error?: string): boolean {
  if (!error) return false
  ctx.status = 400
  ctx.body = { error }
  return true
}

function optionalPositiveNumber(value: unknown, name: string): { value?: number; error?: string } {
  if (value === undefined || value === null) return {}
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return { error: `${name} must be a positive number` }
  return { value: numberValue }
}

export async function list(ctx: Context) {
  const profile = explicitListProfile(ctx)
  if (profile && denyProfileAccess(ctx, profile)) return
  const workflows = filterByAllowedProfiles(ctx, getWorkflowManager().list(profile))
  ctx.body = { workflows }
}

export async function get(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return
  ctx.body = { workflow }
}

export async function listRuns(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const limitValue = firstQueryValue(ctx.query.limit as string | string[] | undefined)
  const limit = limitValue ? Number(limitValue) : 100
  const runs = listWorkflowRuns(id, Number.isFinite(limit) ? limit : 100)
  ctx.body = {
    runs: runs.map(run => ({
      ...run,
      node_sessions: listWorkflowRunNodeSessions(run.id),
    })),
  }
}

export async function stopRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const run = await getWorkflowManager().stopRun(id, runId, 'Workflow run canceled by user')
  if (!run) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true, run }
}

export async function deleteRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const deleted = await getWorkflowManager().deleteRun(id, runId)
  if (!deleted) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true }
}

export async function create(ctx: Context) {
  const body = bodyRecord(ctx)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }

  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return

  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return

  try {
    const workflow = getWorkflowManager().create({
      name,
      profile,
      workspace: workspace.value,
      nodes: nodes.value || [],
      edges: edges.value || [],
      viewport: viewport.value || null,
    })
    ctx.status = 201
    ctx.body = { workflow }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'failed to create workflow' }
  }
}

export async function update(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const existing = getWorkflowManager().get(id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, existing.profile)) return

  const body = bodyRecord(ctx)
  const patch: WorkflowUpdateInput = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      ctx.status = 400
      ctx.body = { error: 'name must be a non-empty string' }
      return
    }
    patch.name = body.name
  }
  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return
  if (workspace.value !== undefined) patch.workspace = workspace.value
  if (nodes.value !== undefined) patch.nodes = nodes.value
  if (edges.value !== undefined) patch.edges = edges.value
  if (viewport.value !== undefined) patch.viewport = viewport.value

  const workflow = getWorkflowManager().update(id, patch)
  ctx.body = { workflow }
}

export async function remove(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  await getWorkflowManager().delete(id)
  ctx.body = { ok: true }
}

export async function batchRemove(ctx: Context) {
  const body = bodyRecord(ctx)
  const ids = Array.isArray(body.ids)
    ? body.ids.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean)
    : []
  if (ids.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required' }
    return
  }
  if (ids.length > MAX_BATCH_DELETE) {
    ctx.status = 400
    ctx.body = { error: `ids must contain at most ${MAX_BATCH_DELETE} items` }
    return
  }

  const uniqueIds = [...new Set(ids)]
  const errors: Array<{ id: string; error: string }> = []
  let deleted = 0
  for (const id of uniqueIds) {
    const workflow = getWorkflowManager().get(id)
    if (!workflow) {
      errors.push({ id, error: 'workflow not found' })
      continue
    }
    if (!canAccessProfile(ctx, workflow.profile)) {
      errors.push({ id, error: `Profile "${profileName(workflow.profile)}" is not available for this user` })
      continue
    }
    if (await getWorkflowManager().delete(id)) deleted += 1
    else errors.push({ id, error: 'workflow not found' })
  }

  ctx.body = {
    deleted,
    failed: errors.length,
    errors,
  }
}

export async function runNow(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const startNodeIds = optionalStringArray(body.start_node_ids ?? body.startNodeIds, 'start_node_ids')
  const input = optionalNullableString(body.input, 'input')
  const timeoutMs = optionalPositiveNumber(body.timeout_ms ?? body.timeoutMs, 'timeout_ms')
  if (rejectBadRequest(ctx, startNodeIds.error || input.error || timeoutMs.error)) return

  const runInput: WorkflowRunNowInput = {
    profile: workflow.profile,
    user: ctx.state?.user,
  }
  if (startNodeIds.value !== undefined) runInput.startNodeIds = startNodeIds.value
  if (input.value !== undefined) runInput.input = input.value
  if (timeoutMs.value !== undefined) runInput.timeoutMs = timeoutMs.value

  const manager = getWorkflowManager()
  void manager.runNow(id, runInput).catch((err: any) => {
    const message = err?.message || 'failed to run workflow'
    logger.error(err, '[workflow] async run failed for workflow %s', id)
    manager.setRuntimeStatus(id, {
      status: 'failed',
      completedAt: Date.now(),
      error: message,
    })
  })

  ctx.status = 202
  ctx.body = { ok: true, status: 'accepted' }
}
