import type { Context } from 'koa'
import {
  handleUpdate as runStudioUpdate,
  installPreview as installVersionPreview,
  preparePreview as prepareVersionPreview,
  previewStatus as getVersionPreviewStatus,
  previewTags as listVersionPreviewTags,
  startPreview as startVersionPreview,
  stopPreview as stopVersionPreview,
} from '../services/update/version-preview-manager'

export async function handleUpdate(ctx: Context): Promise<void> {
  await runStudioUpdate(ctx)
}

export async function previewStatus(ctx: Context): Promise<void> {
  await getVersionPreviewStatus(ctx)
}

export async function previewTags(ctx: Context): Promise<void> {
  await listVersionPreviewTags(ctx)
}

export async function preparePreview(ctx: Context): Promise<void> {
  await prepareVersionPreview(ctx)
}

export async function installPreview(ctx: Context): Promise<void> {
  await installVersionPreview(ctx)
}

export async function startPreview(ctx: Context): Promise<void> {
  await startVersionPreview(ctx)
}

export async function stopPreview(ctx: Context): Promise<void> {
  await stopVersionPreview(ctx)
}
