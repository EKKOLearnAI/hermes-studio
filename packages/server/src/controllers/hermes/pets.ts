import type { Context } from 'koa'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'
import { adoptInstalledPet, adoptPetFromPetdex, deleteInstalledPet, getActivePet, getLocalPetAsset, importLocalPet, listInstalledPets, updateActivePetPreferences } from '../../services/hermes/pets'

const MAX_PET_UPLOAD_BYTES = 10 * 1024 * 1024

function requestedProfile(ctx: Context): string {
  return ctx.state.profile?.name || getActiveProfileName() || 'default'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Pet request failed'
}

export async function active(ctx: Context) {
  ctx.body = { pet: await getActivePet(requestedProfile(ctx)) }
}

export async function adopt(ctx: Context) {
  const body = ctx.request.body as { slug?: unknown } | undefined
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
  if (!slug) {
    ctx.status = 400
    ctx.body = { error: 'Pet slug is required' }
    return
  }

  const profile = requestedProfile(ctx)
  try {
    ctx.body = { pet: await adoptInstalledPet(profile, slug).catch(() => adoptPetFromPetdex(profile, slug)) }
  } catch (err) {
    const message = errorMessage(err)
    ctx.status = message.includes('was not found') ? 404 : 400
    ctx.body = { error: message }
  }
}

export async function updateActive(ctx: Context) {
  const body = ctx.request.body as {
    scale?: unknown
    position?: { x?: unknown; y?: unknown }
    enabled?: unknown
  } | undefined

  const pet = await updateActivePetPreferences(requestedProfile(ctx), {
    scale: typeof body?.scale === 'number' ? body.scale : undefined,
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    position: body?.position && typeof body.position.x === 'number' && typeof body.position.y === 'number'
      ? { x: body.position.x, y: body.position.y }
      : undefined,
  })
  ctx.body = { pet }
}

export async function listLocal(ctx: Context) {
  ctx.body = { pets: await listInstalledPets(requestedProfile(ctx)) }
}

export async function localAsset(ctx: Context) {
  const slug = typeof ctx.params?.slug === 'string' ? ctx.params.slug.trim() : ''
  if (!slug) {
    ctx.status = 400
    ctx.body = { error: 'Pet slug is required' }
    return
  }
  const asset = await getLocalPetAsset(requestedProfile(ctx), slug)
  if (!asset) {
    ctx.status = 404
    ctx.body = { error: 'Local pet asset not found' }
    return
  }
  ctx.set('Content-Type', asset.mime)
  ctx.set('Cache-Control', 'public, max-age=60')
  ctx.body = asset.buffer
}

export async function localPreview(ctx: Context) {
  await localAsset(ctx)
}

export async function deleteLocal(ctx: Context) {
  const slug = typeof ctx.params?.slug === 'string' ? ctx.params.slug.trim() : ''
  if (!slug) {
    ctx.status = 400
    ctx.body = { error: 'Pet slug is required' }
    return
  }
  try {
    ctx.body = await deleteInstalledPet(requestedProfile(ctx), slug)
  } catch (err) {
    const message = errorMessage(err)
    ctx.status = message.includes('was not found') ? 404 : 400
    ctx.body = { error: message }
  }
}

export async function importPet(ctx: Context) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }
  const boundary = parseMultipartBoundary(contentType)
  if (!boundary) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }

  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > MAX_PET_UPLOAD_BYTES) {
      ctx.status = 413
      ctx.body = { error: 'Pet assets exceed the 10 MB limit' }
      return
    }
    chunks.push(chunk)
  }

  const parts: Array<{ fieldName: string; filename: string | null; data: Buffer }> = []
  for (const part of splitMultipart(Buffer.concat(chunks), boundary)) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf-8')
    const nameMatch = header.match(/\bname="([^"]+)"/)
    if (!nameMatch) continue
    try {
      parts.push({
        fieldName: nameMatch[1],
        filename: parseMultipartFilename(header),
        data: part.subarray(headerEnd + 4, part.length > 2 ? part.length - 2 : part.length),
      })
    } catch (err) {
      if (err instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: err.message }
        return
      }
      throw err
    }
  }

  const textField = (name: string) => parts.find(part => part.fieldName === name && part.filename === null)?.data.toString('utf-8').trim() || ''
  const spritesheet = parts.find(part => part.fieldName === 'spritesheet' && part.filename !== null)
  const petJson = parts.find(part => part.fieldName === 'petJson' && part.filename !== null)
  if (!spritesheet) {
    ctx.status = 400
    ctx.body = { error: 'Spritesheet file is required' }
    return
  }

  try {
    const pet = await importLocalPet(requestedProfile(ctx), {
      slug: textField('slug') || textField('displayName'),
      displayName: textField('displayName'),
      kind: textField('kind'),
      submittedBy: textField('submittedBy'),
      spritesheet: spritesheet.data,
      spritesheetFilename: spritesheet.filename || 'spritesheet.png',
      petJson: petJson?.data.toString('utf-8'),
    })
    ctx.status = 201
    ctx.body = { pet }
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: errorMessage(err) }
  }
}
