import type { Context } from 'koa'
import {
  deleteCodingAgent,
  getCodingAgentsStatus,
  installCodingAgent,
  openCodingAgentNativeTerminal,
  prepareCodingAgentLaunch,
  readCodingAgentConfigFile,
  sendCodingAgentRunInput,
  startCodingAgentRun,
  stopCodingAgentRun,
  writeCodingAgentConfigFile,
  type CodingAgentConfigScope,
} from '../services/coding-agents'

function configScope(ctx: Context): CodingAgentConfigScope {
  const body = ctx.request.body as { profile?: unknown; provider?: unknown } | undefined
  return {
    profile: ctx.state.profile?.name || (typeof ctx.query.profile === 'string' ? ctx.query.profile : '') || (typeof body?.profile === 'string' ? body.profile : ''),
    provider: (typeof ctx.query.provider === 'string' ? ctx.query.provider : '') || (typeof body?.provider === 'string' ? body.provider : ''),
  }
}

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
    ctx.body = await readCodingAgentConfigFile(ctx.params.id, ctx.params.key, configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to read coding agent config file' }
  }
}

export async function writeConfigFile(ctx: Context) {
  try {
    const { content } = ctx.request.body as { content?: string }
    ctx.body = await writeCodingAgentConfigFile(ctx.params.id, ctx.params.key, content || '', configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to write coding agent config file' }
  }
}

export async function prepareLaunch(ctx: Context) {
  try {
    const body = ctx.request.body as {
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await prepareCodingAgentLaunch(ctx.params.id, {
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to prepare coding agent launch' }
  }
}

export async function nativeLaunch(ctx: Context) {
  try {
    const body = ctx.request.body as {
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await openCodingAgentNativeTerminal(ctx.params.id, {
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to launch native terminal' }
  }
}

export async function startRun(ctx: Context) {
  try {
    const body = ctx.request.body as {
      sessionId?: string
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await startCodingAgentRun(ctx.params.id, {
      sessionId: String(body.sessionId || ''),
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to start coding agent run' }
  }
}

export async function sendRunInput(ctx: Context) {
  try {
    const body = ctx.request.body as { input?: string }
    ctx.body = await sendCodingAgentRunInput(String(ctx.params.sessionId || ''), String(body.input || ''))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to send coding agent input' }
  }
}

export async function stopRun(ctx: Context) {
  try {
    ctx.body = await stopCodingAgentRun(String(ctx.params.sessionId || ''))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to stop coding agent run' }
  }
}
