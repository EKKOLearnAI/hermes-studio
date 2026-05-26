import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { PREVIEW_SLOT_ID, PreviewRegistryError, getPreviewInstance, listPreviewInstances, startPreviewInstance, stopPreviewInstance } from '../../services/hermes/preview-registry'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function isSuperAdmin(ctx: any): boolean {
  return ctx.state?.user?.role === 'super_admin'
}

function resolvePreviewId(ctx: any): string {
  const previewId = typeof ctx.params?.previewId === 'string' ? ctx.params.previewId.trim() : ''
  return previewId || PREVIEW_SLOT_ID
}

function previewErrorBody(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } }
}

function handlePreviewError(ctx: any, err: any, fallbackMessage: string): void {
  if (err instanceof PreviewRegistryError) {
    ctx.status = err.status
    ctx.body = previewErrorBody(err.code, err.message, err.details)
    return
  }

  ctx.status = 500
  ctx.body = previewErrorBody('preview_registry_error', err?.message || fallbackMessage)
}

function readTargetFromBody(body: any): unknown {
  if (!body || typeof body !== 'object') return null
  if (Object.hasOwn(body, 'target')) return body.target
  if (Object.hasOwn(body, 'preview')) return body.preview
  return body
}

export async function listPreviews(ctx: any) {
  try {
    ctx.body = { previews: await listPreviewInstances(requestedProfile(ctx)) }
  } catch (err: any) {
    handlePreviewError(ctx, err, 'Failed to list preview instances')
  }
}

export async function getPreview(ctx: any) {
  const previewId = resolvePreviewId(ctx)

  try {
    const preview = await getPreviewInstance(requestedProfile(ctx), previewId)
    if (!preview) {
      ctx.status = 404
      ctx.body = previewErrorBody('preview_not_found', `Preview instance not found: ${previewId}`)
      return
    }
    ctx.body = { preview }
  } catch (err: any) {
    handlePreviewError(ctx, err, 'Failed to read preview instance')
  }
}

export async function startPreview(ctx: any) {
  try {
    const preview = await startPreviewInstance(requestedProfile(ctx), readTargetFromBody(ctx.request?.body))
    ctx.status = 201
    ctx.body = { preview }
  } catch (err: any) {
    handlePreviewError(ctx, err, 'Failed to start preview instance')
  }
}

export async function stopPreview(ctx: any) {
  const previewId = resolvePreviewId(ctx)

  try {
    const reason = typeof ctx.request?.body?.reason === 'string' ? ctx.request.body.reason : 'Preview stopped'
    const preview = await stopPreviewInstance(requestedProfile(ctx), previewId, reason)
    ctx.body = { preview }
  } catch (err: any) {
    handlePreviewError(ctx, err, 'Failed to stop preview instance')
  }
}

export const __previewControllerInternals = {
  requestedProfile,
  isSuperAdmin,
  resolvePreviewId,
  previewErrorBody,
}
