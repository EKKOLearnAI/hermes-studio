import { afterEach, expect, it, vi } from 'vitest'
import { DshAgentPresetService } from '../../packages/server/src/modules/coding-agents/services/dsh/agent-presets'
import type { DshManagement } from '../../packages/server/src/modules/coding-agents/services/dsh/management'
const open = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:12345', cookie: 'native-secret', generation: 'fixture' }))
const service = new DshAgentPresetService({ open } as unknown as DshManagement)
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('rejects invalid identifiers and payloads before starting the native host', async () => {
  await expect(service.read('../outside')).rejects.toMatchObject({ status: 400 })
  await expect(service.copy({ from: 'standard', id: 'safe', name: {} })).rejects.toMatchObject({ status: 400 })
  await expect(service.remove('/absolute')).rejects.toMatchObject({ status: 400 })
  expect(open).not.toHaveBeenCalled()
})
it('uses native correlation and keeps credentials in the backend request', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const message = JSON.parse(String(init.body))
    expect(init.headers).toMatchObject({ cookie: 'native-secret', origin: 'http://127.0.0.1:12345' })
    expect(message).toMatchObject({ type: 'client-request', method: 'agentPresets/read', payload: { args: { agentPreset: 'standard' } } })
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { content: '- name: native-tool' } } })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await service.read('standard')).toEqual({ content: '- name: native-tool' })
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:12345/api/agentPresets/read')
})
it('refuses mismatched native responses and unavailable defaults', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } })))
  await expect(service.list()).rejects.toMatchObject({ status: 502, code: 'DSH_PRESET_UNAVAILABLE' })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => Response.json({ type: 'server-response', rpcId: JSON.parse(String(init.body)).rpcId, result: { ok: true, value: { presets: [{ id: 'broken', broken: 'Cannot resolve plugin' }], authorable: true } } })))
  await expect(service.makeDefault('missing')).rejects.toMatchObject({ status: 422 })
  await expect(service.makeDefault('broken')).rejects.toMatchObject({ status: 422 })
})
