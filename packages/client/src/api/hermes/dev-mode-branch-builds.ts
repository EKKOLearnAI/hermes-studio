import { request } from '../client'

export type BranchBuildStatus = 'idle' | 'running' | 'success' | 'failed'

export interface BranchBuildSummary {
  enabled: boolean
  status: BranchBuildStatus
  previewBranch: string | null
  previewWorktreePath: string | null
  buildBranch: string | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  error: string | null
  reviewBase: string
  logTail: string[]
}

export interface BranchBuildListResponse {
  branches: string[]
}

export interface BranchBuildActionResponse extends BranchBuildSummary {
  worktreePath?: string
}

export type BranchPreviewCapabilityReason =
  | 'disabled'
  | 'repo_path_missing'
  | 'not_git_repo'

export interface BranchPreviewCapabilities {
  isSuperAdmin: boolean
  devModeAvailable: boolean
  branchPreviewAvailable: boolean
  branchPreviewConfigured: boolean
  canListBranches: boolean
  canBuild: boolean
  reason: BranchPreviewCapabilityReason | null
}

export async function fetchBranchPreviewCapabilities(): Promise<BranchPreviewCapabilities> {
  return request<BranchPreviewCapabilities>('/api/hermes/dev/branch-builds/capabilities')
}

export async function fetchBranchBuildBranches(): Promise<string[]> {
  const data = await request<BranchBuildListResponse>('/api/hermes/dev/branch-builds/branches')
  return data.branches || []
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
