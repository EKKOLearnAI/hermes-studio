// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const fetchLanDevices = vi.hoisted(() => vi.fn())
const scanLanDevices = vi.hoisted(() => vi.fn())
const fetchDevicePairingLink = vi.hoisted(() => vi.fn())
const requestDevicePairing = vi.hoisted(() => vi.fn())
const requestDevicePairingByUrl = vi.hoisted(() => vi.fn())
const approveDevice = vi.hoisted(() => vi.fn())
const rejectDevice = vi.hoisted(() => vi.fn())
const blockDevice = vi.hoisted(() => vi.fn())
const unblockDevice = vi.hoisted(() => vi.fn())
const deleteDeviceRequestHistory = vi.hoisted(() => vi.fn())
const fetchHealthScaleReadings = vi.hoisted(() => vi.fn())
const fetchScaleSyncSettings = vi.hoisted(() => vi.fn())
const runScaleSync = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/devices', () => ({
  fetchLanDevices,
  scanLanDevices,
  fetchDevicePairingLink,
  requestDevicePairing,
  requestDevicePairingByUrl,
  approveDevice,
  rejectDevice,
  blockDevice,
  unblockDevice,
  deleteDeviceRequestHistory,
}))

vi.mock('@/api/hermes/health-state', () => ({
  fetchHealthScaleReadings,
  fetchScaleSyncSettings,
  runScaleSync,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.count ? `${key}:${params.count}` : key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    props: { loading: Boolean, disabled: Boolean },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  }),
  NDrawer: defineComponent({ name: 'NDrawer', template: '<div><slot /></div>' }),
  NDrawerContent: defineComponent({ name: 'NDrawerContent', template: '<section><slot /></section>' }),
  NInput: defineComponent({
    name: 'NInput',
    inheritAttrs: false,
    props: { value: String },
    emits: ['update:value'],
    template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NModal: defineComponent({ name: 'NModal', template: '<div><slot /></div>' }),
  NPopconfirm: defineComponent({ name: 'NPopconfirm', template: '<div><slot name="trigger" /><slot /></div>' }),
  NSpin: defineComponent({ name: 'NSpin', props: { show: Boolean }, template: '<div><slot /></div>' }),
  NTag: defineComponent({ name: 'NTag', template: '<span class="n-tag-stub"><slot /></span>' }),
}))

import DevicesView from '@/views/hermes/DevicesView.vue'

describe('DevicesView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchLanDevices.mockResolvedValue({ scanning: false, last_scanned_at: null, devices: [], requests: [] })
    fetchScaleSyncSettings.mockResolvedValue({
      enabled: true,
      source: 'xiaomihome',
      username: 'xiaomi-user',
      hasPassword: true,
      passwordMasked: '********',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: 'C:\\tools\\scaleconnect.exe',
      configured: true,
    })
    fetchHealthScaleReadings.mockResolvedValue({
      latest: {
        measuredAt: '2026-07-08T08:41:21+08:00',
        sourceDevice: 'blt.3.1i0amcaqsc400',
        sourceModel: null,
        weightKg: 85,
        bmi: 26.8,
        bodyFatPercent: 23.9,
        bodyScore: 81,
        bodyWaterPercent: 55.6,
        boneSaltKg: 3.5,
        proteinMassKg: 13.2,
        muscleMassKg: 61.2,
        skeletalMuscleMassKg: 34.3,
        basalMetabolismKcal: 1768,
      },
      total: 2,
      readings: [
        {
          id: 'scale-1',
          kind: 'scale_reading',
          source: 'blt.3.1i0amcaqsc400',
          recordedAt: '2026-07-08T08:41:21+08:00',
          value: { weightKg: 85, bodyFatPercent: 23.9, bmi: 26.8, muscleMassKg: 61.2 },
        },
        {
          id: 'scale-2',
          kind: 'scale_reading',
          source: 'blt.3.1i0amcaqsc400',
          recordedAt: '2026-02-25T22:55:35+08:00',
          value: { weightKg: 83.8, bmi: 26.4 },
        },
      ],
    })
    runScaleSync.mockResolvedValue({ status: 'synced', importedCount: 439, readings: [] })
  })

  it('shows connected S400 data as a detailed health device on the devices page', async () => {
    const wrapper = mount(DevicesView)
    await flushPromises()

    expect(fetchScaleSyncSettings).toHaveBeenCalledWith('default')
    expect(fetchHealthScaleReadings).toHaveBeenCalledWith({ profile: 'default', limit: 20 })
    expect(wrapper.find('[data-test="health-device-card"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('米家体脂秤 S400')
    expect(wrapper.text()).toContain('85 kg')
    expect(wrapper.text()).toContain('23.9%')
    expect(wrapper.text()).toContain('26.8')
    expect(wrapper.text()).toContain('61.2 kg')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.findAll('[data-test="health-device-history-row"]')).toHaveLength(2)
  })
})
