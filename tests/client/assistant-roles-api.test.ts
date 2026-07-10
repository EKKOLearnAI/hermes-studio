import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/assistant-roles'

const role = { id: 'health / lead', name: 'Health Lead' }

describe('assistant roles API', () => {
  beforeEach(() => request.mockReset())

  it('lists roles and unwraps the response', async () => {
    request.mockResolvedValue({ roles: [role] })
    await expect(api.fetchAssistantRoles()).resolves.toEqual([role])
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles')
  })

  it('fetches encoded role details with recipes', async () => {
    request.mockResolvedValue({ role, recipes: [{ id: 'daily' }] })
    await expect(api.fetchAssistantRole(role.id)).resolves.toEqual({ ...role, recipes: [{ id: 'daily' }] })
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead')
  })

  it('creates a role and unwraps it', async () => {
    const input = { name: 'Health Lead' }
    request.mockResolvedValue({ role })
    await expect(api.createAssistantRole(input as never)).resolves.toEqual(role)
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles', {
      method: 'POST', body: JSON.stringify(input),
    })
  })

  it('updates an encoded role and unwraps it', async () => {
    request.mockResolvedValue({ role })
    await expect(api.updateAssistantRole(role.id, { name: 'Health Lead' })).resolves.toEqual(role)
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead', {
      method: 'PUT', body: JSON.stringify({ name: 'Health Lead' }),
    })
  })

  it('deletes an encoded role', async () => {
    request.mockResolvedValue({ success: true })
    await expect(api.deleteAssistantRole(role.id)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead', { method: 'DELETE' })
  })

  it('clones an encoded role and unwraps the clone', async () => {
    const input = { id: 'recovery', name: 'Recovery' }
    request.mockResolvedValue({ role: { ...role, ...input } })
    await expect(api.cloneAssistantRole(role.id, input)).resolves.toEqual({ ...role, ...input })
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead/clone', {
      method: 'POST', body: JSON.stringify(input),
    })
  })

  it('updates an encoded role profile mapping and unwraps nullable mappings', async () => {
    const mapping = { roleId: role.id, profileName: 'primary', isPrimary: true }
    request.mockResolvedValue({ mapping })
    await expect(api.updateAssistantRoleProfileMapping(role.id, 'primary')).resolves.toEqual(mapping)
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead/profile-mapping', {
      method: 'PUT', body: JSON.stringify({ profileName: 'primary' }),
    })
  })

  it('previews encoded role context and unwraps the server bundle', async () => {
    const input = { query: 'next checkup', recipeId: 'daily' }
    const context = { role, renderedInstructions: 'Use trusted facts.' }
    request.mockResolvedValue({ context })
    await expect(api.previewAssistantRoleContext(role.id, input)).resolves.toEqual(context)
    expect(request).toHaveBeenCalledWith('/api/hermes/assistant-roles/health%20%2F%20lead/context/preview', {
      method: 'POST', body: JSON.stringify(input),
    })
  })

  it('does not expose arbitrary Personal Twin write methods', () => {
    expect(Object.keys(api).filter(name => /write|upsert|observation|event/i.test(name))).toEqual([])
  })
})
