// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const isStoredSuperAdminMock = vi.hoisted(() => vi.fn())
const fetchBranchPreviewCapabilitiesMock = vi.hoisted(() => vi.fn())
const fetchBranchBuildStatusMock = vi.hoisted(() => vi.fn())
const fetchBranchBuildBranchesMock = vi.hoisted(() => vi.fn())
const fetchAvailableReleasesMock = vi.hoisted(() => vi.fn())
const buildBranchPreviewMock = vi.hoisted(() => vi.fn())
const promoteBranchPreviewMock = vi.hoisted(() => vi.fn())
const restoreLatestUpstreamReleaseMock = vi.hoisted(() => vi.fn())
const savePreviewRepositoryMock = vi.hoisted(() => vi.fn())
const useMessageMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
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
  saveSection: vi.fn(async () => {}),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: () => isStoredSuperAdminMock(),
}))

vi.mock('@/api/hermes/dev-mode-branch-builds', () => ({
  buildBranchPreview: (...args: any[]) => buildBranchPreviewMock(...args),
  fetchBranchPreviewCapabilities: (...args: any[]) => fetchBranchPreviewCapabilitiesMock(...args),
  fetchBranchBuildStatus: (...args: any[]) => fetchBranchBuildStatusMock(...args),
  fetchBranchBuildBranches: (...args: any[]) => fetchBranchBuildBranchesMock(...args),
  fetchAvailableReleases: (...args: any[]) => fetchAvailableReleasesMock(...args),
  promoteBranchPreview: (...args: any[]) => promoteBranchPreviewMock(...args),
  restoreLatestUpstreamRelease: (...args: any[]) => restoreLatestUpstreamReleaseMock(...args),
  savePreviewRepository: (...args: any[]) => savePreviewRepositoryMock(...args),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
}))

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
    NSelect: {
      props: ['value', 'options', 'disabled', 'loading', 'filterable', 'clearable', 'placeholder'],
      emits: ['update:value'],
      template: '<select class="n-select" :disabled="disabled" @change="$emit(\'update:value\', $event.target.value)"><option v-for="opt in options" :key="opt.value" :value="opt.value" :disabled="opt.disabled">{{ opt.label }}</option></select>',
    },
    NSwitch: {
      props: ['value', 'disabled', 'loading'],
      emits: ['update:value'],
      template: '<button class="n-switch" type="button" :disabled="disabled" @click="$emit(\'update:value\', !value)">{{ value ? "on" : "off" }}</button>',
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
    vi.spyOn(Date, 'now').mockReturnValue(1710000000000)
    isStoredSuperAdminMock.mockReset()
    fetchBranchPreviewCapabilitiesMock.mockReset()
    fetchBranchBuildStatusMock.mockReset()
    fetchBranchBuildBranchesMock.mockReset()
    fetchAvailableReleasesMock.mockReset()
    fetchAvailableReleasesMock.mockResolvedValue(['0.6.1'])
    buildBranchPreviewMock.mockReset()
    promoteBranchPreviewMock.mockReset()
    restoreLatestUpstreamReleaseMock.mockReset()
    savePreviewRepositoryMock.mockReset()
    savePreviewRepositoryMock.mockResolvedValue({ descriptor: { type: 'git-url', url: 'https://github.com/example/repo.git' }, resolution: { configured: true, available: true, reason: null, repoRoot: '/tmp/repo', cachePath: '/tmp/cache', remoteUrl: 'https://github.com/example/repo.git' } })
    useMessageMock.success.mockReset()
    useMessageMock.error.mockReset()
    useMessageMock.warning.mockReset()
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
    settingsStoreMock.saveSection.mockClear()
    settingsStoreMock.saveSection.mockImplementation(async (section: string, values: Record<string, any>) => {
      if (section === 'dev') {
        settingsStoreMock.dev = { ...settingsStoreMock.dev, ...values }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the stable card and hides preview controls for normal users', async () => {
    isStoredSuperAdminMock.mockReturnValue(false)

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(wrapper.text()).toContain('updates.currentStableTitle')
    expect(wrapper.text()).toContain('updates.latestReleaseVersion')
    expect(wrapper.text()).toContain('updates.lastChecked')
    expect(wrapper.text()).toContain(new Date(1710000000000).toLocaleString())
    expect(wrapper.text()).toContain('updates.previewTitle')
    expect(wrapper.text()).toContain('Source type')
    expect(wrapper.text()).not.toContain('Open preview')
    expect(wrapper.text()).not.toContain('Preview -> Stable')
    expect(fetchBranchPreviewCapabilitiesMock).not.toHaveBeenCalled()
    expect(fetchBranchBuildStatusMock).not.toHaveBeenCalled()
    expect(fetchBranchBuildBranchesMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      title: 'Dev Mode off + missing repo keeps release enabled and hides dev-only sources',
      devModeEnabled: false,
      capabilityReason: 'repo_path_missing',
      branchAvailable: false,
      commitAvailable: false,
      expectedSourceOptions: [
        { label: 'Release', disabled: false },
      ],
    },
    {
      title: 'Dev Mode on + missing repo keeps release enabled but disables dev-only sources',
      devModeEnabled: true,
      capabilityReason: 'repo_path_missing',
      branchAvailable: false,
      commitAvailable: false,
      expectedSourceOptions: [
        { label: 'Release', disabled: false },
        { label: 'Branch', disabled: true },
        { label: 'Commit', disabled: true },
      ],
    },
    {
      title: 'Dev Mode on + invalid repo keeps release enabled but disables dev-only sources',
      devModeEnabled: true,
      capabilityReason: 'not_git_repo',
      branchAvailable: false,
      commitAvailable: false,
      expectedSourceOptions: [
        { label: 'Release', disabled: false },
        { label: 'Branch', disabled: true },
        { label: 'Commit', disabled: true },
      ],
    },
    {
      title: 'Dev Mode on + valid repo enables every source option',
      devModeEnabled: true,
      capabilityReason: null,
      branchAvailable: true,
      commitAvailable: true,
      expectedSourceOptions: [
        { label: 'Release', disabled: false },
        { label: 'Branch', disabled: false },
        { label: 'Commit', disabled: false },
      ],
    },
  ])('$title', async ({ devModeEnabled, capabilityReason, branchAvailable, commitAvailable, expectedSourceOptions }) => {
    isStoredSuperAdminMock.mockReturnValue(true)
    settingsStoreMock.dev.enabled = devModeEnabled
    fetchBranchPreviewCapabilitiesMock.mockResolvedValue({
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: branchAvailable,
      branchPreviewConfigured: branchAvailable,
      canListBranches: branchAvailable,
      canBuild: branchAvailable,
      reason: capabilityReason,
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: branchAvailable,
          configured: branchAvailable,
          devOnly: true,
          canListTargets: branchAvailable,
          canBuild: branchAvailable,
          reason: capabilityReason,
        },
        {
          provider: 'commit',
          available: commitAvailable,
          configured: commitAvailable,
          devOnly: true,
          canListTargets: commitAvailable,
          canBuild: commitAvailable,
          reason: capabilityReason,
        },
      ],
    })
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'running',
      previewId: null,
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['line 1'],
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    const selects = wrapper.findAll('select')
    expect(selects.length).toBeGreaterThanOrEqual(devModeEnabled ? 3 : 2)

    const sourceSelect = selects[devModeEnabled ? 1 : 0]
    const sourceOptions = sourceSelect.findAll('option').map((option) => ({
      label: option.text(),
      disabled: (option.element as HTMLOptionElement).disabled,
    }))
    expect(sourceOptions).toEqual(expectedSourceOptions)

    const releaseButton = wrapper.findAll('button').find((button) => button.text() === 'settings.dev.buildPreview')
    expect(releaseButton?.element.disabled).toBe(false)
  })

  it('loads release preview state for super admins even when Dev Mode is disabled', async () => {
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
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'commit',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
      ],
    })
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'running',
      previewId: null,
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['line 1'],
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(fetchBranchPreviewCapabilitiesMock).toHaveBeenCalledTimes(1)
    expect(fetchBranchBuildStatusMock).toHaveBeenCalledTimes(1)
    expect(fetchBranchBuildBranchesMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('updates.previewTitle')
    expect(wrapper.text()).toContain('Source type')
    expect(wrapper.text()).toContain('Release')
    expect(wrapper.text()).not.toContain('Branch')
    expect(wrapper.text()).not.toContain('Commit')
    expect(wrapper.text()).toContain('updates.previewBody')
    expect(wrapper.text()).toContain('updates.previewStableCopy')
    expect(wrapper.text()).toContain('line 1')
    expect(wrapper.text()).toContain('/preview/')
    expect(wrapper.text()).toContain('running')
  })

  it('enables Dev Mode from the preview card and reveals branch and commit sources', async () => {
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
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'commit',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
      ],
    })
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'running',
      previewId: null,
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['line 1'],
    })
    fetchBranchBuildBranchesMock.mockResolvedValue([
      'feature/z',
      'feature/a',
      'main',
    ])

    const wrapper = mount(UpdatesView)
    await flushPromises()

    const switchButton = wrapper.find('button.n-switch')
    expect(switchButton.exists()).toBe(true)
    expect(wrapper.text()).toContain('updates.previewStableCopy')
    expect(wrapper.text()).toContain('settings.dev.disabledNote')

    await switchButton.trigger('click')
    await flushPromises()

    expect(settingsStoreMock.saveSection).toHaveBeenCalledWith(
      'dev',
      expect.objectContaining({ enabled: true }),
    )
    expect(fetchBranchBuildBranchesMock).toHaveBeenCalledTimes(1)
    const selects = wrapper.findAll('select')
    expect(selects.length).toBeGreaterThanOrEqual(3)
    expect(selects[1].findAll('option').map((option) => option.text())).toEqual([
      'Release',
      'Branch',
      'Commit',
    ])
    expect(selects[2].findAll('option').map((option) => option.text())).toEqual(['0.6.1'])
  })

  it('expands source choices and shows failure logs when Dev Mode is enabled', async () => {
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
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'commit',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
      ],
    })
    fetchBranchBuildBranchesMock.mockResolvedValue([
      'feature/z',
      'upstream-pr/adr-009-singleton-updates-preview',
      'feature/a',
    ])
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'failed',
      previewId: 'preview-123',
      previewUrl: '/preview/',
      previewBranch: 'feature/dev-b',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'feature/dev-b',
      startedAt: 1710000000000,
      finishedAt: 1710000001000,
      exitCode: 1,
      signal: 'SIGTERM',
      error: 'build exploded',
      reviewBase: 'main',
      logTail: ['line one', 'line two'],
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    expect(fetchBranchBuildBranchesMock).toHaveBeenCalledTimes(1)
    const selects = wrapper.findAll('select')
    expect(selects.length).toBeGreaterThanOrEqual(3)
    expect(selects[1].findAll('option').map((option) => option.text())).toEqual([
      'Release',
      'Branch',
      'Commit',
    ])
    expect(selects[2].findAll('option').map((option) => option.text())).toEqual(['0.6.1'])

    await selects[1].setValue('branch')
    await flushPromises()

    const branchSelects = wrapper.findAll('select')
    expect(branchSelects.length).toBeGreaterThanOrEqual(3)
    expect(branchSelects[2].findAll('option').map((option) => option.text())).toEqual([
      'feature/a',
      'feature/dev-b',
      'feature/z',
      'upstream-pr/adr-009-singleton-updates-preview',
    ])

    expect(wrapper.text()).toContain('line one')
    expect(wrapper.text()).toContain('line two')
    expect(wrapper.text()).toContain('build exploded')
    expect(wrapper.text()).toContain('failed')
    expect(wrapper.text()).not.toContain('Preview -> Stable')
    expect(wrapper.text()).not.toContain('Open preview')
  })

  it('builds a preview from the release source and promotes the ready preview', async () => {
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
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'commit',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
      ],
    })
    fetchBranchBuildStatusMock.mockResolvedValue({
      status: 'success',
      previewId: 'preview-123',
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: 1710000001000,
      exitCode: 0,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['ready'],
    })
    restoreLatestUpstreamReleaseMock.mockResolvedValue({
      status: 'success',
      previewId: 'preview-123',
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: 1710000001000,
      exitCode: 0,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['ready'],
    })
    promoteBranchPreviewMock.mockResolvedValue({
      status: 'success',
      previewId: 'preview-123',
      previewUrl: '/preview/',
      previewBranch: 'main',
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'main',
      startedAt: 1710000000000,
      finishedAt: 1710000001000,
      exitCode: 0,
      signal: null,
      error: null,
      reviewBase: 'main',
      logTail: ['ready'],
    })

    const wrapper = mount(UpdatesView)
    await flushPromises()

    const buildButton = wrapper.findAll('button').find((button) => button.text() === 'settings.dev.buildPreview')!
    expect(buildButton.exists()).toBe(true)
    expect(wrapper.text()).toContain('Open preview')
    expect(wrapper.text()).toContain('Preview -> Stable')

    await buildButton.trigger('click')
    await flushPromises()
    expect(restoreLatestUpstreamReleaseMock).toHaveBeenCalledWith('0.6.1')

    const promoteButton = wrapper.findAll('button').find((button) => button.text() === 'Preview -> Stable')!
    await promoteButton.trigger('click')
    await flushPromises()
    expect(promoteBranchPreviewMock).toHaveBeenCalledTimes(1)
    expect(useMessageMock.success).toHaveBeenCalledWith('settings.dev.promotePreviewDone')
  })
})
