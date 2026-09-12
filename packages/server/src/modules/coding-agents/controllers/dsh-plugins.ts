import type { Context } from 'koa'
import { DshPluginError, getDshPluginStore } from '../services/dsh/plugins'
import { executeDshPluginCommand, getNativeDshPluginInventory } from '../services'

function errorResponse(ctx: Context, error: unknown) {
  ctx.status = error instanceof DshPluginError ? error.status : 500
  ctx.body = { code: error instanceof DshPluginError ? error.code : 'DSH_PLUGIN_OPERATION_FAILED',
    error: error instanceof DshPluginError ? error.message : 'Unable to access plugin state', retryable: ctx.status >= 500 }
}
export async function list(ctx: Context) {
  try { ctx.body = await getDshPluginStore().snapshot() } catch (error) { errorResponse(ctx, error) }
}
export async function submit(ctx: Context) {
  try {
    const revision = ctx.get('If-Match')
    if (revision && !/^"[A-Za-z0-9_-]+"$/.test(revision)) throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Expected a quoted revision in If-Match')
    ctx.body = await getDshPluginStore().submit(ctx.request.body, revision ? revision.slice(1, -1) : undefined, executeDshPluginCommand)
    ctx.status = 202
  } catch (error) { errorResponse(ctx, error) }
}
export async function operation(ctx: Context) {
  try { ctx.body = await getDshPluginStore().operation(ctx.params.operationId) } catch (error) { errorResponse(ctx, error) }
}

export async function inventory(ctx: Context) {
  try { ctx.body = await getNativeDshPluginInventory() } catch (error) { errorResponse(ctx, error) }
}
