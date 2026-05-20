import type { Context } from 'koa'
import { scanCodeIntelligence } from '../../services/hermes/code-intelligence/scanner'

export async function summary(ctx: Context) {
  try {
    ctx.body = await scanCodeIntelligence(process.cwd())
  } catch (error) {
    ctx.status = 500
    ctx.body = {
      error: 'Failed to scan code intelligence',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
