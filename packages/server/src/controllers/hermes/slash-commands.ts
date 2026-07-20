import { listSlashCommands } from '../../services/hermes/slash-commands'

/**
 * GET /api/hermes/slash-commands
 *
 * Returns registered skill bundles (and eventually skill commands)
 * for dynamic slash command autocomplete in the web UI.
 */
export async function list(ctx: any) {
  try {
    const result = await listSlashCommands()
    ctx.body = result
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to list slash commands' }
  }
}
