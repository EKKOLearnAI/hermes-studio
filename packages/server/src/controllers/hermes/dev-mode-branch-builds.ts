import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getBranchBuildSummary, getBranchPreviewCapabilities, isDevModeEnabled, listRepositoryBranches, promotePreviewTarget, removePreviewTarget, resetPreviewTarget, restoreLatestUpstreamRelease, startBranchBuild } from '../../services/hermes/dev-mode-branch-builds'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function isSuperAdmin(ctx: any): boolean {
  return ctx.state?.user?.role === 'super_admin'
}

async function requireDevMode(ctx: any): Promise<string | null> {
  const profile = requestedProfile(ctx)
  if (!await isDevModeEnabled(profile)) {
    ctx.status = 403
    ctx.body = { error: 'Dev Mode is disabled' }
    return null
  }
  return profile
}

export async function getCapabilities(ctx: any) {
  try {
    ctx.body = await getBranchPreviewCapabilities(requestedProfile(ctx), isSuperAdmin(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to read branch preview capabilities' }
  }
}

export async function listBranches(ctx: any) {
  try {
    ctx.body = { branches: await listRepositoryBranches() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to list branches' }
  }
}

export async function getStatus(ctx: any) {
  try {
    ctx.body = await getBranchBuildSummary(requestedProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to read branch build status' }
  }
}

export async function buildBranch(ctx: any) {
  const { branch } = ctx.request.body as { branch?: string }
  if (!branch || !branch.trim()) {
    ctx.status = 400
    ctx.body = { error: 'Missing branch' }
    return
  }

  try {
    const profile = await requireDevMode(ctx)
    if (!profile) return
    const result = await startBranchBuild(profile, branch.trim())
    ctx.body = { ...await getBranchBuildSummary(profile), worktreePath: result.worktreePath }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Branch build failed' }
  }
}

export async function resetBranchPreview(ctx: any) {
  try {
    const profile = await requireDevMode(ctx)
    if (!profile) return
    ctx.body = await resetPreviewTarget(profile)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to reset preview target' }
  }
}

export async function removeBranchPreview(ctx: any) {
  try {
    const profile = await requireDevMode(ctx)
    if (!profile) return
    ctx.body = await removePreviewTarget(profile)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to remove preview target' }
  }
}

export async function promoteBranchPreview(ctx: any) {
  try {
    const profile = await requireDevMode(ctx)
    if (!profile) return
    ctx.body = await promotePreviewTarget(profile)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to promote preview target' }
  }
}

export async function restoreLatestRelease(ctx: any) {
  try {
    const profile = await requireDevMode(ctx)
    if (!profile) return
    ctx.body = await restoreLatestUpstreamRelease(profile)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to restore latest upstream release' }
  }
}
