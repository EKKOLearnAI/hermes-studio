import type { Context } from 'koa'
import {
  deleteCodingAgent,
  getCodingAgentsStatus,
  installCodingAgent,
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
} from '../services/coding-agents'

export async function status(ctx: Context) {
  try {
    ctx.body = await getCodingAgentsStatus()
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to inspect coding agents' }
  }
}

export async function install(ctx: Context) {
  try {
    const result = await installCodingAgent(ctx.params.id)
    ctx.body = result
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to install coding agent' }
  }
}

export async function remove(ctx: Context) {
  try {
    const result = await deleteCodingAgent(ctx.params.id)
    ctx.body = result
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to delete coding agent' }
  }
}

export async function readConfigFile(ctx: Context) {
  try {
    ctx.body = await readCodingAgentConfigFile(ctx.params.id, ctx.params.key)
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to read coding agent config file' }
  }
}

export async function writeConfigFile(ctx: Context) {
  try {
    const { content } = ctx.request.body as { content?: string }
    ctx.body = await writeCodingAgentConfigFile(ctx.params.id, ctx.params.key, content || '')
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to write coding agent config file' }
  }
}
