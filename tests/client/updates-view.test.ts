// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const isStoredSuperAdminMock = vi.hoisted(() => vi.fn())
const fetchBranchPreviewCapabilitiesMock = vi.hoisted(() => vi.fn())
const fetchBranchBuildStatusMock = vi.hoisted(() => vi.fn())
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
  }
})

import UpdatesView from '@/views/hermes/UpdatesView.vue'

describe('UpdatesView', () => {
  beforeEach(() => {
    isStoredSuperAdminMock.mockReset()
    fetchBranchPreviewCapabilitiesMock.mockReset()
    fetchBranchBuildStatusMock.mockReset()
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
    expect(wrapper.text()).toContain('updates.previewTitle')
    expect(wrapper.text()).toContain('updates.recoveryTitle')
    expect(wrapper.text()).not.toContain('updates.openDevMode')
    expect(fetchBranchPreviewCapabilitiesMock).not.toHaveBeenCalled()
  })

  it('loads Dev Mode preview status for super admins and can open Dev Mode settings', async () => {
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

    expect(fetchBranchPreviewCapabilitiesMock).toHaveBeenCalledTimes(1)
    expect(fetchBranchBuildStatusMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('upstream-pr/adr-009-singleton-updates-preview')
    expect(wrapper.text()).toContain('upstream/main')
    expect(wrapper.text()).toContain('updates.openDevMode')
  })

  it('starts the update flow from the recovery section', async () => {
    isStoredSuperAdminMock.mockReturnValue(false)
    const wrapper = mount(UpdatesView)
    await flushPromises()

    const updateButton = wrapper.findAll('button').find(node => node.text() === 'updates.updateNow')
    expect(updateButton).toBeTruthy()

    await updateButton!.trigger('click')
    expect(appStoreMock.doUpdate).toHaveBeenCalledTimes(1)
    expect(useMessageMock.success).toHaveBeenCalledWith('updates.updateStarted')
  })
})
