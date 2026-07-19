// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  activateRuntimeVersion: vi.fn(),
  activateWebUiVersion: vi.fn(),
  deleteRuntimeVersion: vi.fn(),
  deleteWebUiVersion: vi.fn(),
  downloadRuntimeVersion: vi.fn(),
  downloadWebUiVersion: vi.fn(),
  fetchRuntimeVersionStatus: vi.fn(),
  fetchVersionDownloadJobs: vi.fn(),
  selectRuntimeRoot: vi.fn(),
}))

const selectRuntimeDirectory = vi.hoisted(() => vi.fn())
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/hermes/runtime-versions', () => api)
vi.mock('@/utils/desktop-bridge', () => ({
  desktopBridge: () => ({ selectRuntimeDirectory }),
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('naive-ui', () => ({
  NAlert: { template: '<div><slot /></div>' },
  NButton: { template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>' },
  NDrawer: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NPopconfirm: { template: '<div><slot name="trigger" /><slot /></div>' },
  NProgress: { template: '<div />' },
  NSpin: { template: '<div><slot /></div>' },
  NTag: { template: '<span><slot /></span>' },
  useMessage: () => message,
}))

import VersionManagementModal from '@/components/layout/VersionManagementModal.vue'

function runtimeStatus() {
  return {
    active: null,
    platform: 'mac-arm64',
    activeVersionPath: '/state/desktop-runtime/active-version.json',
    remoteManifestUrl: '',
    remoteError: '',
    hermes: {
      activeVersion: '0.18.0',
      activeDirectory: '/state/desktop-runtime/hermes/0.18.0/mac-arm64',
      storageDirectory: '/state/desktop-runtime',
      defaultStorageDirectory: '/state/desktop-runtime',
      pendingStorageDirectory: '',
      migrationError: '',
      installed: [],
      remoteVersions: [],
    },
    webui: {
      currentVersion: '0.6.31',
      activeVersion: '0.6.31',
      activeDirectory: '',
      installed: [],
      remoteVersions: [],
    },
  }
}

describe('VersionManagementModal Runtime storage selector', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    selectRuntimeDirectory.mockReset()
    message.success.mockReset()
    message.error.mockReset()
    api.fetchRuntimeVersionStatus.mockResolvedValue(runtimeStatus())
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [] })
    api.selectRuntimeRoot.mockResolvedValue({ success: true, active: {} })
  })

  it('opens the desktop picker and schedules migration to the selected directory', async () => {
    selectRuntimeDirectory.mockResolvedValue('/Volumes/HermesRuntime')
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="select-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(selectRuntimeDirectory).toHaveBeenCalledWith('/state/desktop-runtime')
    expect(api.selectRuntimeRoot).toHaveBeenCalledWith('/Volumes/HermesRuntime')
    expect(message.success).toHaveBeenCalledWith('runtimeVersions.runtimeDirectorySaved')
  })

  it('does not schedule migration when the desktop picker is canceled', async () => {
    selectRuntimeDirectory.mockResolvedValue(null)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="select-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(api.selectRuntimeRoot).not.toHaveBeenCalled()
  })

  it('schedules migration back to the system default directory', async () => {
    const status = runtimeStatus()
    status.hermes.storageDirectory = '/Volumes/HermesRuntime'
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    await wrapper.get('[data-testid="reset-runtime-directory"]').trigger('click')
    await flushPromises()

    expect(api.selectRuntimeRoot).toHaveBeenCalledWith('/state/desktop-runtime')
    expect(message.success).toHaveBeenCalledWith('runtimeVersions.runtimeDirectorySaved')
  })
})
