import type { Context } from 'koa'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import {
  approvePendingWrite,
  getPendingWriteReview,
  listPendingWrites,
  rejectPendingWrite,
} from '../../services/hermes/write-gate'

function requestedProfile(ctx: Context): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function pendingParams(ctx: Context): { subsystem: string; id: string } {
  return {
    subsystem: String(ctx.params.subsystem || ''),
    id: String(ctx.params.id || ''),
  }
}

function handleError(ctx: Context, err: any) {
  const message = err?.stderr || err?.message || String(err)
  if (/Invalid write gate subsystem|Invalid pending write id/i.test(message)) {
    ctx.status = 400
  } else if (/No pending .* write with id/i.test(message)) {
    ctx.status = 404
  } else if (/write approval is not supported/i.test(message)) {
    ctx.status = 409
  } else {
    ctx.status = 500
  }
  ctx.body = { error: message.trim() }
}

export async function list(ctx: Context) {
  try {
    ctx.body = await listPendingWrites(requestedProfile(ctx))
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function diff(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    const review = await getPendingWriteReview(requestedProfile(ctx), subsystem, id)
    ctx.body = {
      diff: review.diff,
      review,
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

/**
 * Detect failure indicators in the Python subprocess output.
 * The Python helper (handle_pending_subcommand) returns error messages as
 * plain text without raising exceptions, so we must inspect the output string.
 */
function outputIndicatesFailure(output: string): boolean {
  if (!output) return false
  return (
    /Approved 0 /i.test(output) ||
    /Rejected 0 /i.test(output) ||
    /Failed:/i.test(output) ||
    /No pending .* write with id/i.test(output)
  )
}

function handleApprovalResult(ctx: Context, output: string) {
  if (outputIndicatesFailure(output)) {
    // Return HTTP 200 with success:false so the frontend can inspect the
    // output field for the specific failure reason. A non-2xx status would
    // cause the client's request() helper to throw before the caller ever
    // sees the response body.
    ctx.body = { success: false, output }
  } else {
    ctx.body = { success: true, output }
  }
}

export async function approve(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    const output = await approvePendingWrite(requestedProfile(ctx), subsystem, id)
    handleApprovalResult(ctx, output)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function reject(ctx: Context) {
  try {
    const { subsystem, id } = pendingParams(ctx)
    const output = await rejectPendingWrite(requestedProfile(ctx), subsystem, id)
    handleApprovalResult(ctx, output)
  } catch (err: any) {
    handleError(ctx, err)
  }
}
