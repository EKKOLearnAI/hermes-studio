import type { HomeBindingDto, HomeDeviceDto } from '@/api/hermes/home'

export type HomeFreshness = 'fresh' | 'aging' | 'stale' | 'unknown'
export type HomeDeviceActionDraft =
  | { kind: 'set_power'; deviceId: string; bindingId: string; externalId: string; expectedStateVersion: number; desiredPower: boolean }
  | { kind: 'set_level'; deviceId: string; bindingId: string; externalId: string; expectedStateVersion: number; desiredLevel: number }
  | { kind: 'set_temperature'; deviceId: string; bindingId: string; externalId: string; expectedStateVersion: number; desiredTemperatureC: number }
  | { kind: 'activate_scene'; deviceId: string; bindingId: string; externalId: string }

export function latestHomeObservation(device: HomeDeviceDto): string | null {
  let latest: string | null = null
  let timestamp = Number.NEGATIVE_INFINITY
  for (const state of device.states) {
    const candidate = Date.parse(state.observedAt)
    if (Number.isFinite(candidate) && candidate > timestamp) { timestamp = candidate; latest = state.observedAt }
  }
  return latest
}

export function homeDeviceFreshness(device: HomeDeviceDto, now = Date.now()): HomeFreshness {
  const observedAt = latestHomeObservation(device)
  if (!observedAt) return 'unknown'
  const age = now - Date.parse(observedAt)
  if (!Number.isFinite(age) || age < 0) return 'unknown'
  if (age <= 5 * 60_000) return 'fresh'
  if (age <= 30 * 60_000) return 'aging'
  return 'stale'
}

export function homeStateVersion(device: HomeDeviceDto, key: string): number {
  return device.states.find(state => state.key === key)?.version ?? 0
}

export function primaryHomeBinding(device: HomeDeviceDto): HomeBindingDto | null {
  return device.bindings.find(binding => binding.provider === 'home-assistant') ?? null
}
