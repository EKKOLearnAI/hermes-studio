import Router from '@koa/router'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { listSessionSummaries } from '../../services/hermes/sessions-db'
import { logger } from '../../services/logger'

export const sessionRoutes = new Router()

// List sessions from Hermes
sessionRoutes.get('/api/hermes/sessions', async (ctx) => {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listSessionSummaries(source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions }
})

// Get single session with messages
sessionRoutes.get('/api/hermes/sessions/:id', async (ctx) => {
  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
})

// Delete session from Hermes
sessionRoutes.delete('/api/hermes/sessions/:id', async (ctx) => {
  const ok = await hermesCli.deleteSession(ctx.params.id)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  ctx.body = { ok: true }
})

// Rename session
sessionRoutes.post('/api/hermes/sessions/:id/rename', async (ctx) => {
  const { title } = ctx.request.body as { title?: string }
  if (!title || typeof title !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const ok = await hermesCli.renameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
})
