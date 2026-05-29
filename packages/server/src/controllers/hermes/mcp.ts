import type { Context } from 'koa'
import { bridgeMcpAction } from '../../services/hermes/mcp'

function getProfile(ctx: Context): string | undefined {
  return (ctx.state as any)?.profile?.name || undefined
}

export async function listServers(ctx: Context) {
  try {
    ctx.body = await bridgeMcpAction('mcp_list', {}, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function addServer(ctx: Context) {
  try {
    const { name, config } = ctx.request.body || {}
    if (!name || !config) {
      ctx.status = 400
      ctx.body = { error: 'name and config are required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_add', { name, config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to add MCP server' }
  }
}

export async function updateServer(ctx: Context) {
  try {
    const name = decodeURIComponent(ctx.params.name)
    const { config } = ctx.request.body || {}
    if (!config) {
      ctx.status = 400
      ctx.body = { error: 'config is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_update', { name, config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to update MCP server' }
  }
}

export async function removeServer(ctx: Context) {
  try {
    const name = decodeURIComponent(ctx.params.name)
    ctx.body = await bridgeMcpAction('mcp_server_remove', { name }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to remove MCP server' }
  }
}

export async function testServer(ctx: Context) {
  try {
    const name = decodeURIComponent(ctx.params.name)
    ctx.body = await bridgeMcpAction('mcp_server_test', { name }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to test MCP server' }
  }
}

export async function listTools(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const payload = server ? { server } : {}
    ctx.body = await bridgeMcpAction('mcp_tools_list', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function reloadMcp(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const payload = server ? { server } : {}
    ctx.body = await bridgeMcpAction('mcp_reload', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to reload MCP' }
  }
}
