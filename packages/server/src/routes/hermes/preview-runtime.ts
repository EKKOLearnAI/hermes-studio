import type { Context, Next } from 'koa'
import send from 'koa-send'
import { access } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getPreviewInstance } from '../../services/hermes/preview-registry'
import { buildUnavailablePreviewHtml, readSpaShell } from '../../services/spa-shell'

const PREVIEW_ROUTE_RE = /^\/preview\/([^/]+)(?:\/(.*))?$/

interface PreviewRuntimeMatch {
  previewId: string
  trailingPath: string
  baseHref: string
}

function parsePreviewRuntimePath(pathname: string): PreviewRuntimeMatch | null {
  const match = pathname.match(PREVIEW_ROUTE_RE)
  if (!match) return null

  const previewId = match[1]
  const trailingPath = match[2] ?? ''
  return {
    previewId,
    trailingPath,
    baseHref: `/preview/${previewId}/`,
  }
}

function isAssetRequest(relativePath: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(relativePath)
}

async function resolvePreviewRoot(profile: string, previewId: string): Promise<string | null> {
  const preview = await getPreviewInstance(profile, previewId)
  if (!preview) return null
  if (preview.status !== 'success') return null
  if (preview.target.type !== 'git-branch') return null
  if (!preview.target.worktreePath) return null

  const root = join(preview.target.worktreePath, 'dist', 'client')
  try {
    await access(join(root, 'index.html'))
  } catch {
    return null
  }
  return root
}

function unavailablePreviewResponse(previewId: string, message: string, status = 503): { status: number, type: string, body: string } {
  return {
    status,
    type: 'html',
    body: buildUnavailablePreviewHtml(`Preview ${previewId}`, message),
  }
}

export async function previewRuntimeMiddleware(ctx: Context, next: Next): Promise<void> {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    await next()
    return
  }

  const match = parsePreviewRuntimePath(ctx.path)
  if (!match) {
    await next()
    return
  }

  if (ctx.path === `/preview/${match.previewId}`) {
    ctx.redirect(match.baseHref)
    return
  }

  const profile = getActiveProfileName()
  const previewRoot = await resolvePreviewRoot(profile, match.previewId)
  if (!previewRoot) {
    const unavailable = unavailablePreviewResponse(match.previewId, 'Preview is unavailable or still building.')
    ctx.status = unavailable.status
    ctx.type = unavailable.type
    ctx.body = unavailable.body
    return
  }

  const relativePath = match.trailingPath.trim()
  if (relativePath && isAssetRequest(relativePath)) {
    try {
      await send(ctx, relativePath, { root: previewRoot })
      return
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error
      }

      const unavailable = unavailablePreviewResponse(match.previewId, `Asset not found: ${relativePath}`, 404)
      ctx.status = unavailable.status
      ctx.type = unavailable.type
      ctx.body = unavailable.body
      return
    }
  }

  ctx.type = 'html'
  ctx.body = await readSpaShell(previewRoot, match.baseHref)
}
