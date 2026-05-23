import { createEmptyOpsRuntimeSnapshot, getOpsRuntimeSnapshot } from '../../services/hermes/ops-monitor'

export async function runtime(ctx: any) {
  try {
    ctx.body = await getOpsRuntimeSnapshot()
  } catch (err: any) {
    ctx.body = createEmptyOpsRuntimeSnapshot(err?.message || 'Failed to read performance metrics')
  }
}
