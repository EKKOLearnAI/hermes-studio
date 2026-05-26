// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const isStoredSuperAdminMock = vi.hoisted(() => vi.fn())
const fetchBranchPreviewCapabilitiesMock = vi.hoisted(() => vi.fn())
const fetchBranchBuildStatusMock = vi.hoisted(() => vi.fn())
const fetchBranchBuildBranchesMock = vi.hoisted(() => vi.fn())
const routerPushMock = vi.hoisted(() => vi.fn())
const useMessageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))
const appStoreMock = vi.hoisted(() => ({
  connected: true,
  serverVersion: '0.6.0',
  latestVersion: '0.6.1',
  updateAvailable: true,
  clientOutdated: false,
  updating: false,
  checkConnection: vi.fn(async () => {}),
  doUpdate: vi.fn(async () => true),
  reloadClient: vi.fn(),
}))
const settingsStoreMock = vi.hoisted(() => ({
  dev: { enabled: false },
  fetchSettings: vi.fn(async () => {}),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: () => isStoredSuperAdminMock(),
}))

vi.mock('@/api/hermes/dev-mode-branch-builds', () => ({
  fetchBranchPreviewCapabilities: (...args: any[]) => fetchBranchPreviewCapabilitiesMock(...args),
  fetchBranchBuildStatus: (...args: any[]) => fetchBranchBuildStatusMock(...args),
  fetchBranchBuildBranches: (...args: any[]) => fetchBranchBuildBranchesMock(...args),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRouter: () => ({ push: routerPushMock }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => useMessageMock,
    NAlert: {
      props: ['title', 'type'],
      template: '<div class="n-alert"><strong v-if="title">{{ title }}</strong><slot /></div>',
    },
    NButton: {
      props: ['loading', 'disabled', 'type', 'size'],
      template: '<button :disabled="disabled" v-bind="$attrs"><slot /></button>',
    },
    NCard: {
      props: ['title', 'size'],
      template: '<section class="n-card"><header><slot name="header-extra" />{{ title }}</header><div class="n-card-body"><slot /></div></section>',
    },
    NSpace: {
      template: '<div class="n-space"><slot /></div>',
    },
    NSpin: {
      props: ['show', 'size', 'description'],
      template: '<div class="n-spin"><slot /></div>',
    },
    NTag: {
      props: ['type', 'size'],
      template: '<span class="n-tag"><slot /></span>',
    },
    NSelect: {
      props: ['value', 'options', 'disabled', 'loading', 'filterable', 'clearable', 'placeholder'],
      emits: ['update:value'],
      template: '<select class="n-select" :disabled="disabled" @change="$emit(\'update:value\', $event.target.value)"><option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option></select>',
    },
    NSwitch: {
      props: ['value', 'disabled'],
      emits: ['update:value'],
      template: '<button class="n-switch" :disabled="disabled" @click="$emit(\'update:value\', !value)">{{ value ? "on" : "off" }}</button>',
    },
  }
})

import UpdatesView from '@/views/hermes/UpdatesView.vue'

describe('UpdatesView', () => {
  beforeEach(() => {
    isStoredSuperAdminMock.mockReset()
    fetchBranchPreviewCapabilitiesMock.mockReset()
    fetchBranchBuildStatusMock.mockReset()
    fetchBranchBuildBranchesMock.mockReset()
    routerPushMock.mockReset()
    useMessageMock.success.mockReset()
    useMessageMock.error.mockReset()
    appStoreMock.connected = true
    appStoreMock.serverVersion = '0.6.0'
    appStoreMock.latestVersion = '0.6.1'
    appStoreMock.updateAvailable = true
    appStoreMock.clientOutdated = false
    appStoreMock.updating = false
    appStoreMock.checkConnection.mockClear()
    appStoreMock.doUpdate.mockClear()
    appStoreMock.reloadClient.mockClear()
    settingsStoreMock.dev.enabled = false
    settingsStoreMock.fetchSettings.mockClear()
  })

  it('shows the release-first sections and keeps preview controls hidden for normal users', async () => {
    isStoredSuperAdminMock.mockReturnValue(false)

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(wrapper.text()).toContain('updates.currentStableTitle')
    expect(wrapper.text()).toContain('updates.latestReleaseTitle')
    expect(wrapper.text()).toContain('updates.recoveryTitle')
    expect(wrapper.text()).not.toContain('updates.previewTitle')
    expect(wrapper.text()).not.toContain('settings.dev.warningTitle')
    expect(wrapper.text()).not.toContain('settings.dev.branchPreviewTitle')
    expect(fetchBranchPreviewCapabilitiesMock).not.toHaveBeenCalled()
    expect(fetchBranchBuildStatusMock).not.toHaveBeenCalled()
    expect(fetchBranchBuildBranchesMock).not.toHaveBeenCalled()
  })

  it('shows the Dev Mode warning but keeps branch controls hidden until Dev Mode is enabled', async () => {
    isStoredSuperAdminMock.mockReturnValue(true)
    settingsStoreMock.dev.enabled = false
    fetchBranchPreviewCapabilitiesMock.mockResolvedValue({
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: true,
      branchPreviewConfigured: true,
      canListBranches: true,
      canBuild: true,
      reason: null,
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(wrapper.text()).toContain('settings.dev.warningTitle')
    expect(wrapper.text()).toContain('settings.dev.warningBody')
    expect(wrapper.text()).toContain('settings.dev.enabled')
    expect(wrapper.text()).toContain('common.save')
    expect(wrapper.text()).not.toContain('settings.dev.branchPreviewTitle')
    expect(fetchBranchPreviewCapabilitiesMock).toHaveBeenCalledTimes(1)
    expect(fetchBranchBuildStatusMock).not.toHaveBeenCalled()
    expect(fetchBranchBuildBranchesMock).not.toHaveBeenCalled()
  })

  it('loads Dev Mode preview status for super admins after Dev Mode is enabled', async () => {
    isStoredSuperAdminMock.mockReturnValue(true)
    settingsStoreMock.dev.enabled = true
    fetchBranchPreviewCapabilitiesMock.mockResolvedValue({
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: true,
      branchPreviewConfigured: true,
      canListBranches: true,
      canBuild: true,
      reason: null,
    })
    fetchBranchBuildBranchesMock.mockResolvedValue([
      'feature/z',
      'upstream-pr/adr-009-singleton-updates-preview',
      'feature/a',
    ])
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'running',
      previewBranch: 'upstream-pr/adr-009-singleton-updates-preview',
      reviewBase: 'upstream/main',
      previewWorktreePath: '/tmp/worktree',
      previewUrl: 'https://example.test/preview/123/',
      startedAt: 1710000000000,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      logTail: ['line 1'],
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(fetchBranchPreviewCapabilitiesMock).toHaveBeenCalledTimes(2)
    expect(fetchBranchBuildStatusMock).toHaveBeenCalledTimes(2)
    expect(fetchBranchBuildBranchesMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('updates.previewTitle')
    expect(wrapper.text()).toContain('settings.dev.branchPreviewTitle')
    expect(wrapper.text()).toContain('settings.dev.buildPreview')
    expect(wrapper.text()).toContain('settings.dev.resetToBase')
    expect(wrapper.text()).toContain('upstream-pr/adr-009-singleton-updates-preview')
    expect(wrapper.text()).toContain('upstream/main')
    expect(wrapper.text()).toContain('settings.dev.advancedDetails')
    expect(wrapper.text()).not.toContain('updates.openDevMode')
    expect(wrapper.findAll('button').filter(node => node.text() === 'updates.updateNow')).toHaveLength(1)
  })

  it('starts the update flow from the header action only', async () => {
    isStoredSuperAdminMock.mockReturnValue(false)
    const wrapper = mount(UpdatesView)
    await flushPromises()

    const updateButtons = wrapper.findAll('button').filter(node => node.text() === 'updates.updateNow')
    expect(updateButtons).toHaveLength(1)

    await updateButtons[0].trigger('click')
    expect(appStoreMock.doUpdate).toHaveBeenCalledTimes(1)
    expect(useMessageMock.success).toHaveBeenCalledWith('updates.updateStarted')
  })
})
