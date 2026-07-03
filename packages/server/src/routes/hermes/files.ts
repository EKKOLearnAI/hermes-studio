import Router from '@koa/router'
import {
  createFileProvider,
  resolveHermesPath,
  isSensitivePath,
  MAX_EDIT_SIZE,
} from '../../services/hermes/file-provider'
import { requireSuperAdmin } from '../../middleware/user-auth'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'
import { getSession } from '../../db/hermes/session-store'
import { isPathWithin, relativePathFromBase } from '../../services/hermes/hermes-path'
import { resolve as pathResolve } from 'path'

function requestedProfile(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function requestedSessionId(ctx: any): string {
  const querySessionId = typeof ctx.query?.session_id === 'string' ? ctx.query.session_id.trim() : ''
  const bodySessionId = typeof ctx.request?.body?.session_id === 'string' ? ctx.request.body.session_id.trim() : ''
  return querySessionId || bodySessionId
}

function getSessionWorkspace(ctx: any): string | null {
  const sessionId = requestedSessionId(ctx)
  if (!sessionId) return null
  const session = getSession(sessionId)
  if (!session) throw Object.assign(new Error('Session not found'), { code: 'not_found' })
  if (session.profile && session.profile !== (requestedProfile(ctx) || 'default')) {
    throw Object.assign(new Error('Session profile mismatch'), { code: 'permission_denied' })
  }
  const workspace = String(session.workspace || '').trim()
  if (!workspace) throw Object.assign(new Error('Session workspace not found'), { code: 'not_found' })
  return workspace
}

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === '.' || relativePath === '/') return ''
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  return normalized
}

function resolveRequestPath(ctx: any, relativePath: string): string {
  const workspace = getSessionWorkspace(ctx)
  if (!workspace) return resolveHermesPath(relativePath, requestedProfile(ctx))
  const normalized = normalizeRelativePath(relativePath)
  const resolved = normalized ? pathResolve(workspace, normalized) : workspace
  if (!isPathWithin(resolved, workspace)) throw Object.assign(new Error('Path traversal detected'), { code: 'invalid_path' })
  return resolved
}

async function createRequestFileProvider(ctx: any) {
  return createFileProvider(requestedProfile(ctx))
}

function joinRelativePath(parentPath: string, name: string): string {
  const parent = normalizeRelativePath(parentPath)
  return parent ? `${parent}/${name}` : name
}

function withAbsolutePath<T extends { path: string; name?: string }>(ctx: any, entry: T, parentPath = ''): T & { absolutePath: string } {
  const workspace = getSessionWorkspace(ctx)
  if (!workspace) return { ...entry, absolutePath: resolveRequestPath(ctx, entry.path) }
  const relativePath = entry.name ? joinRelativePath(parentPath, entry.name) : normalizeRelativePath(entry.path)
  const absolutePath = resolveRequestPath(ctx, relativePath)
  return { ...entry, path: relativePathFromBase(absolutePath, workspace) ?? relativePath, absolutePath }
}

export const fileRoutes = new Router()

function handleError(ctx: any, err: any) {
  const code = err.code || 'unknown'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    not_found: 404,
    ENOENT: 404,
    already_exists: 409,
    permission_denied: 403,
    file_too_large: 413,
    not_a_directory: 400,
    not_a_file: 400,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

// GET /api/hermes/files/list?path=
fileRoutes.get('/api/hermes/files/list', async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const entries = await provider.listDir(absPath)
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { entries: entries.map(entry => withAbsolutePath(ctx, entry, relativePath)), path: relativePath, absolutePath: absPath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/stat?path=
fileRoutes.get('/api/hermes/files/stat', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const info = await provider.stat(absPath)
    ctx.body = withAbsolutePath(ctx, { ...info, path: relativePath })
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', requireSuperAdmin, async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const data = await provider.readFile(absPath)
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// PUT /api/hermes/files/write  body: { path, content }
fileRoutes.put('/api/hermes/files/write', requireSuperAdmin, async (ctx) => {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', requireSuperAdmin, async (ctx) => {
  const { path: relativePath, recursive } = (ctx.request.body || {}) as { path?: string; recursive?: boolean }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    if (recursive) {
      await provider.deleteDir(absPath)
    } else {
      await provider.deleteFile(absPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/rename  body: { oldPath, newPath }
fileRoutes.post('/api/hermes/files/rename', requireSuperAdmin, async (ctx) => {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (isSensitivePath(oldPath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absOld = resolveRequestPath(ctx, oldPath)
    const absNew = resolveRequestPath(ctx, newPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', requireSuperAdmin, async (ctx) => {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', requireSuperAdmin, async (ctx) => {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  try {
    const absSrc = resolveRequestPath(ctx, srcPath)
    const absDest = resolveRequestPath(ctx, destPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', requireSuperAdmin, async (ctx) => {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const parts = splitMultipart(raw, boundaryBuf)
  const provider = await createRequestFileProvider(ctx)
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message, code: 'invalid_request' }
        return
      }
      throw error
    }
    if (!filename) continue

    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File ${filename} too large`, code: 'file_too_large' }
      return
    }

    const filePath = targetDir ? `${targetDir}/${filename}` : filename
    if (isSensitivePath(filePath)) {
      ctx.status = 403
      ctx.body = { error: `Cannot overwrite sensitive file: ${filename}`, code: 'permission_denied' }
      return
    }

    const absPath = resolveRequestPath(ctx, filePath)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})
