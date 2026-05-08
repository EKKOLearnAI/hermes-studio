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

export async function list(ctx: Context) {
  const { status, assignee, tenant } = ctx.query as Record<string, string | undefined>
  try {
    const tasks = await kanbanCli.listTasks({ status, assignee, tenant })
    ctx.body = { tasks }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: Context) {
  try {
    const detail = await kanbanCli.getTask(ctx.params.id)
    if (!detail) {
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
  try {
    const task = await kanbanCli.createTask(title, { body, assignee, priority, tenant })
    ctx.body = { task }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function complete(ctx: Context) {
  const { task_ids, summary } = ctx.request.body as {
    task_ids?: string[]
    summary?: string
  }
  if (!task_ids?.length) {
    ctx.status = 400
    ctx.body = { error: 'task_ids is required' }
    return
  }
  try {
    await kanbanCli.completeTasks(task_ids, summary)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function block(ctx: Context) {
  const { reason } = ctx.request.body as { reason?: string }
  if (!reason) {
    ctx.status = 400
    ctx.body = { error: 'reason is required' }
    return
  }
  try {
    await kanbanCli.blockTask(ctx.params.id, reason)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function unblock(ctx: Context) {
  const { task_ids } = ctx.request.body as { task_ids?: string[] }
  if (!task_ids?.length) {
    ctx.status = 400
    ctx.body = { error: 'task_ids is required' }
    return
  }
  try {
    await kanbanCli.unblockTasks(task_ids)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function assign(ctx: Context) {
  const { profile } = ctx.request.body as { profile?: string }
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'profile is required' }
    return
  }
  try {
    await kanbanCli.assignTask(ctx.params.id, profile)
    ctx.body = { ok: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function stats(ctx: Context) {
  try {
    const stats = await kanbanCli.getStats()
    ctx.body = { stats }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function assignees(ctx: Context) {
  try {
    const assignees = await kanbanCli.getAssignees()
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
