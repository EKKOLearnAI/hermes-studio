import type { Context, Next } from 'koa'
import send from 'koa-send'
import { access } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { PREVIEW_SLOT_ID, getPreviewInstance } from '../../services/hermes/preview-registry'
import { buildUnavailablePreviewHtml, readSpaShell } from '../../services/spa-shell'

const PREVIEW_BASE_PATH = '/preview/'
const PREVIEW_ROUTE_RE = /^\/preview(?:\/(.*))?$/
const KNOWN_ROUTE_PREFIXES = new Set([
  'assets',
  'channels',
  'files',
  'group-chat',
  'hermes',
  'history',
  'jobs',
  'kanban',
  'logs',
  'memory',
  'models',
  'performance',
  'plugins',
  'profiles',
  'ಸೆशన్',
  'session',
  'settings',
  'skills',
  'skills-usage',
  'terminal',
  'usage',
])

interface PreviewRuntimeMatch {
  trailingPath: string
  redirectTo: string | null
}

function isAssetRequest(relativePath: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(relativePath)
}

function parsePreviewRuntimePath(pathname: string): PreviewRuntimeMatch | null {
  if (pathname === '/preview') {
    return { trailingPath: '', redirectTo: PREVIEW_BASE_PATH }
  }

  const match = pathname.match(PREVIEW_ROUTE_RE)
  if (!match) return null

  const trailingPath = (match[1] ?? '').trim()
  if (!trailingPath) {
    return { trailingPath: '', redirectTo: null }
  }

  const segments = trailingPath.split('/').filter(Boolean)
  const firstSegment = segments[0] ?? ''

  if (!KNOWN_ROUTE_PREFIXES.has(firstSegment)) {
    const stripped = segments.slice(1).join('/')
    if (!stripped) {
      return { trailingPath: '', redirectTo: PREVIEW_BASE_PATH }
    }

    if (isAssetRequest(stripped)) {
      return { trailingPath: stripped, redirectTo: null }
    }

    return {
      trailingPath: stripped,
      redirectTo: `${PREVIEW_BASE_PATH}${stripped}`,
    }
  }

  return { trailingPath, redirectTo: null }
}

async function resolvePreviewRoot(profile: string): Promise<string | null> {
  const preview = await getPreviewInstance(profile, PREVIEW_SLOT_ID)
  if (!preview) return null
  if (preview.status !== 'success') return null
  if (preview.target.type === 'git-branch') {
    if (!preview.target.worktreePath) return null
    const root = join(preview.target.worktreePath, 'dist', 'client')
    try {
      await access(join(root, 'index.html'))
    } catch {
      return null
    }
    return root
  }

  if (preview.target.type === 'release-artifact') {
    if (!preview.target.artifactPath) return null
    const root = join(preview.target.artifactPath, 'dist', 'client')
    try {
      await access(join(root, 'index.html'))
    } catch {
      return null
    }
    return root
  }

  return null
}

function unavailablePreviewResponse(message: string, status = 503): { status: number, type: string, body: string } {
  return {
    status,
    type: 'html',
    body: buildUnavailablePreviewHtml('Preview', message),
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

  if (match.redirectTo && ctx.path !== match.redirectTo) {
    ctx.redirect(match.redirectTo)
    return
  }

  const profile = getActiveProfileName()
  const previewRoot = await resolvePreviewRoot(profile)
  if (!previewRoot) {
    const unavailable = unavailablePreviewResponse('Preview is unavailable or still building.')
    ctx.status = unavailable.status
    ctx.type = unavailable.type
    ctx.body = unavailable.body
    return
  }

  if (match.trailingPath && isAssetRequest(match.trailingPath)) {
    try {
      await send(ctx, match.trailingPath, { root: previewRoot })
      return
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error
      }

      const unavailable = unavailablePreviewResponse(`Asset not found: ${match.trailingPath}`, 404)
      ctx.status = unavailable.status
      ctx.type = unavailable.type
      ctx.body = unavailable.body
      return
    }
  }

  ctx.type = 'html'
  ctx.body = await readSpaShell(previewRoot, PREVIEW_BASE_PATH)
}
