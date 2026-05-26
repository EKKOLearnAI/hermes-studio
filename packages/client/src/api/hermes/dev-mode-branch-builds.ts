import { request } from '../client'

export type PreviewInstanceStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped'

export type PreviewCapabilityReason =
  | 'disabled'
  | 'repo_path_missing'
  | 'not_git_repo'

export type PreviewTargetKind = 'installed-version' | 'release-artifact' | 'docker-image' | 'git-branch'
export type PreviewProviderKey = 'installed-version' | 'release-artifact' | 'docker-image' | 'git-branch-worktree'
export type PreviewSourceKind = 'release' | 'branch' | 'commit'

export interface PreviewSourceCapability {
  provider: PreviewSourceKind
  available: boolean
  configured: boolean
  devOnly: boolean
  canListTargets: boolean
  canBuild: boolean
  reason: PreviewCapabilityReason | null
}

export interface InstalledVersionPreviewTarget {
  type: 'installed-version'
  version: string
}

export interface ReleaseArtifactPreviewTarget {
  type: 'release-artifact'
  version: string
  source: 'github-release'
}

export interface DockerImagePreviewTarget {
  type: 'docker-image'
  image: string
}

export interface GitBranchPreviewTarget {
  type: 'git-branch'
  repo: string
  branch: string
  provider: 'git-branch-worktree'
  devOnly: true
  worktreePath?: string | null
}

export type PreviewTarget =
  | InstalledVersionPreviewTarget
  | ReleaseArtifactPreviewTarget
  | DockerImagePreviewTarget
  | GitBranchPreviewTarget

export interface PreviewInstance {
  id: string
  target: PreviewTarget
  status: PreviewInstanceStatus
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  logTail: string[]
  updatedAt: number
}

export interface PreviewProviderCapability {
  provider: PreviewProviderKey
  available: boolean
  configured: boolean
  devOnly: boolean
  canListTargets: boolean
  canBuild: boolean
  reason: PreviewCapabilityReason | null
}

export interface PreviewProviderCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  providers: PreviewProviderCapability[]
}

export interface PreviewInstanceSummary extends PreviewInstance {
  enabled: boolean
  reviewBase: string
  previewBranch: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
}

export type BranchBuildStatus = PreviewInstanceStatus

export interface BranchBuildSummary {
  enabled: boolean
  status: BranchBuildStatus
  previewId: string | null
  previewUrl: string | null
  previewBranch: string | null
  previewReleaseVersion: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
  buildReleaseVersion: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  reviewBase: string
  logTail: string[]
}

export interface AvailableReleasesResponse {
  releases: string[]
}

export interface BranchBuildListResponse {
  branches: string[]
}

export interface BranchBuildActionResponse extends BranchBuildSummary {
  worktreePath?: string
}

export type BranchPreviewCapabilityReason = PreviewCapabilityReason

export interface BranchPreviewCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  branchPreviewAvailable: boolean
  branchPreviewConfigured: boolean
  canListBranches: boolean
  canBuild: boolean
  reason: BranchPreviewCapabilityReason | null
  providers?: PreviewSourceCapability[]
}

export async function fetchBranchPreviewCapabilities(): Promise<BranchPreviewCapabilities> {
  return request<BranchPreviewCapabilities>('/api/hermes/dev/branch-builds/capabilities')
}

export async function fetchBranchBuildBranches(): Promise<string[]> {
  const data = await request<BranchBuildListResponse>('/api/hermes/dev/branch-builds/branches')
  return data.branches || []
}

export async function fetchAvailableReleases(): Promise<string[]> {
  const data = await request<AvailableReleasesResponse>('/api/hermes/dev/branch-builds/releases')
  return data.releases || []
}

export async function fetchBranchBuildStatus(): Promise<BranchBuildSummary> {
  return request<BranchBuildSummary>('/api/hermes/dev/branch-builds/status')
}

export async function buildBranchPreview(branch: string): Promise<BranchBuildActionResponse> {
  return request<BranchBuildActionResponse>('/api/hermes/dev/branch-builds/build', {
    method: 'POST',
    body: JSON.stringify({ branch }),
  })
}

export async function resetBranchPreview(): Promise<BranchBuildSummary> {
  return request<BranchBuildSummary>('/api/hermes/dev/branch-builds/reset', {
    method: 'POST',
  })
}

export async function removeBranchPreview(): Promise<BranchBuildSummary> {
  return request<BranchBuildSummary>('/api/hermes/dev/branch-builds/remove', {
    method: 'POST',
  })
}

export async function promoteBranchPreview(): Promise<BranchBuildSummary> {
  return request<BranchBuildSummary>('/api/hermes/dev/branch-builds/promote', {
    method: 'POST',
  })
}

export async function restoreLatestUpstreamRelease(version?: string): Promise<BranchBuildSummary> {
  return request<BranchBuildSummary>('/api/hermes/dev/branch-builds/restore-latest-release', {
    method: 'POST',
    body: JSON.stringify(version ? { version } : {}),
  })
}
