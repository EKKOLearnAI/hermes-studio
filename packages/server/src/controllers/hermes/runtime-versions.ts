import type { Context } from 'koa'
import {
  activateInstalledRuntimeVersion,
  activateDownloadedWebUiVersion,
  deleteDownloadedWebUiVersion,
  deleteInstalledRuntimeVersion,
  getVersionDownloadJob,
  getRuntimeVersionStatus,
  listVersionDownloadJobs,
  startRuntimeVersionDownload,
  startWebUiVersionDownload,
  type VersionDownloadSource,
} from '../../services/runtime-version-manager'

function parseDownloadSource(value: unknown): VersionDownloadSource {
  return value === 'github' ? 'github' : 'cf'
}

export async function status(ctx: Context) {
  ctx.body = await getRuntimeVersionStatus()
}

export async function activateRuntime(ctx: Context) {
  const body = ctx.request.body as { version?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  try {
    const active = activateInstalledRuntimeVersion(version)
    ctx.body = { success: true, active }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteRuntime(ctx: Context) {
  const version = String(ctx.params.version || '')
  try {
    const deleted = deleteInstalledRuntimeVersion(version)
    ctx.body = { success: true, deleted }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function activateWebUi(ctx: Context) {
  const body = ctx.request.body as { version?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  try {
    const active = activateDownloadedWebUiVersion(version)
    ctx.body = { success: true, active }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteWebUi(ctx: Context) {
  const version = String(ctx.params.version || '')
  try {
    const deleted = deleteDownloadedWebUiVersion(version)
    ctx.body = { success: true, deleted }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function downloadRuntime(ctx: Context) {
  const body = ctx.request.body as { version?: unknown; source?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  const source = parseDownloadSource(body?.source)
  try {
    const job = startRuntimeVersionDownload(version, source)
    ctx.status = 202
    ctx.body = { success: true, job }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function downloadWebUi(ctx: Context) {
  const body = ctx.request.body as { version?: unknown; source?: unknown }
  const version = typeof body?.version === 'string' ? body.version : ''
  const source = parseDownloadSource(body?.source)
  try {
    const job = startWebUiVersionDownload(version, source)
    ctx.status = 202
    ctx.body = { success: true, job }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function jobs(ctx: Context) {
  ctx.body = { jobs: listVersionDownloadJobs() }
}

export async function job(ctx: Context) {
  const id = String(ctx.params.id || '')
  const downloadJob = getVersionDownloadJob(id)
  if (!downloadJob) {
    ctx.status = 404
    ctx.body = { error: 'Version download job not found' }
    return
  }
  ctx.body = downloadJob
}
