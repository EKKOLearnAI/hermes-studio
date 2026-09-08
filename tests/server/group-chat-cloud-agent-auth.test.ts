import { expect, it, vi } from 'vitest'
import { groupAgentSocketAuth, normalizeCloudAgentMachineId } from '../../packages/server/src/modules/studio/services/group-chat/cloud-agent-auth'
import { createDeviceSignature } from '../../packages/server/src/modules/studio/public/system-info'
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  getPublicSystemInfo: vi.fn(async () => ({ device_id: 'hwui_source_machine_1234567890', device_public_key: 'source-key' })),
  createDeviceSignature: vi.fn(async (nonce: string) => `signature:${nonce}`),
}))
it('keeps direct connections unchanged and signs fresh cloud handshakes on reconnect', async () => {
  const credentials = { connectorId: 'connector', credential: 'target-secret', targetOrigin: 'http://source.example' }
  expect(groupAgentSocketAuth(credentials)).toBe(credentials)
  const auth = groupAgentSocketAuth(credentials, 'hwui_target_machine_1234567890') as Function
  const first: any = await new Promise(resolve => auth(resolve))
  const next: any = await new Promise(resolve => auth(resolve))
  expect(first).toMatchObject({ ...credentials, machineId: 'hwui_target_machine_1234567890', sourceMachineId: 'hwui_source_machine_1234567890', publicKey: 'source-key' })
  expect(first.nonce).not.toBe(next.nonce)
  expect(createDeviceSignature).toHaveBeenCalledWith(next.nonce, next.timestamp)
  expect(next.signature).toBe(`signature:${next.nonce}`)
})
it('rejects malformed cloud routing instead of falling back to a direct connection', () => {
  expect(normalizeCloudAgentMachineId(undefined)).toBeUndefined()
  for (const value of ['http://host', 'hwui_x', {}, 12]) expect(() => normalizeCloudAgentMachineId(value)).toThrow()
})
