import { request } from '../client'

export interface WebPetPosition {
  x: number
  y: number
}

export interface ActivePet {
  enabled: boolean
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  source: 'petdex'
  mime: string
  spritesheetDataUrl: string
  spritesheetRevision: number
  frameW: number
  frameH: number
  framesPerState: number
  loopMs: number
  scale: number
  position?: WebPetPosition
  stateRows: string[]
  installedAt: number
  updatedAt: number
}

export async function fetchActivePet(): Promise<ActivePet | null> {
  const res = await request<{ pet: ActivePet | null }>('/api/hermes/pets/active')
  return res.pet
}

export async function adoptPet(slug: string): Promise<ActivePet> {
  const res = await request<{ pet: ActivePet }>('/api/hermes/pets/adopt', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
  return res.pet
}

export async function updateActivePetPreferences(input: {
  scale?: number
  position?: WebPetPosition
  enabled?: boolean
}): Promise<ActivePet | null> {
  const res = await request<{ pet: ActivePet | null }>('/api/hermes/pets/active', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return res.pet
}

export interface LocalImportedPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  source: 'petdex' | 'local'
  spritesheetFile: string
  petJsonFile?: string
  mime: string
  installedAt: number
  updatedAt: number
}

export async function fetchLocalPets(): Promise<LocalImportedPet[]> {
  const res = await request<{ pets: LocalImportedPet[] }>('/api/hermes/pets/local')
  return res.pets
}

export function localPetAssetUrl(slug: string): string {
  return `/api/hermes/pets/local/${encodeURIComponent(slug)}/asset`
}

export function localPetPreviewUrl(slug: string): string {
  return `/api/hermes/pets/local/${encodeURIComponent(slug)}/preview`
}

export async function importLocalPet(input: {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  spritesheet: File
  petJson?: File | null
}): Promise<LocalImportedPet> {
  const form = new FormData()
  form.append('slug', input.slug)
  form.append('displayName', input.displayName)
  form.append('kind', input.kind)
  form.append('submittedBy', input.submittedBy)
  form.append('spritesheet', input.spritesheet)
  if (input.petJson) form.append('petJson', input.petJson)
  const res = await request<{ pet: LocalImportedPet }>('/api/hermes/pets/import', {
    method: 'POST',
    body: form,
  })
  return res.pet
}

export async function deleteLocalPet(slug: string): Promise<{ deleted: boolean; wasActive: boolean }> {
  return request<{ deleted: boolean; wasActive: boolean }>(`/api/hermes/pets/local/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}
