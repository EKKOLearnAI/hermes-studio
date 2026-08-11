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
      agentVersion: 'v0.19.1 (2026.7.30) · upstream 3f497e2b · local 470cf66b (+1 carried commit)',
      activeDirectory: '/state/desktop-runtime/hermes/0.18.0/mac-arm64',
      storageDirectory: '/state/desktop-runtime',
      defaultStorageDirectory: '/state/desktop-runtime',
      pendingStorageDirectory: '',
      migrationError: '',
      activationError: '',
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

  it('explains how to update Hermes Runtime from the command line', async () => {
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    const note = wrapper.get('[data-testid="runtime-cli-update-note"]')
    expect(note.text()).toContain('runtimeVersions.cliUpdateDescription')
    expect(note.text()).toContain('hermes-studio cli update')
  })

  it('shows the installed Hermes Agent version instead of the Runtime package version', async () => {
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    const activeVersion = wrapper.get('[data-testid="active-hermes-agent-version"]')
    expect(activeVersion.text()).toContain('v0.19.1 (2026.7.30)')
    expect(activeVersion.text()).not.toContain('upstream')
    expect(activeVersion.text()).not.toContain('0.18.0')
    expect(activeVersion.attributes('title')).toContain('local 470cf66b')

    const runtimeDirectory = wrapper.get('[data-testid="active-runtime-directory"]')
    expect(runtimeDirectory.text()).toContain('/state/desktop-runtime/hermes/0.18.0/mac-arm64')
  })

  it('shows the Runtime fallback reason and hides Web UI version switching', async () => {
    const status = runtimeStatus()
    status.hermes.activationError = 'Selected Runtime 0.20.0 is missing node/node.exe.'
    status.webui.remoteVersions = ['0.6.32']
    api.fetchRuntimeVersionStatus.mockResolvedValue(status)
    const wrapper = mount(VersionManagementModal, { props: { show: false } })
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.get('[data-testid="runtime-activation-error"]').text())
      .toContain('Selected Runtime 0.20.0 is missing node/node.exe.')
    expect(wrapper.text()).not.toContain('runtimeVersions.webUiTitle')
    expect(wrapper.text()).not.toContain('0.6.32')
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
