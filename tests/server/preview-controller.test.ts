import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as ctrl from '../../packages/server/src/controllers/hermes/previews'

let hermesHome = ''

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'preview-controller-'))
  process.env.HERMES_HOME = hermesHome
  mkdirSync(join(hermesHome, 'profiles', 'profile-a'), { recursive: true })
})

afterEach(() => {
  delete process.env.HERMES_HOME
  if (hermesHome) {
    rmSync(hermesHome, { recursive: true, force: true })
  }
})

function makeCtx(state: any = {}) {
  return {
    state,
    request: { body: {} },
    params: {},
    status: 0,
    body: undefined as any,
  }
}

describe('preview controller', () => {
  it('starts, lists, reads and stops the singleton preview slot', async () => {
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    ctx.request.body = {
      target: {
        type: 'docker-image',
        image: 'ghcr.io/kira-project-lab/hermes-web-ui:preview',
      },
    }

    await ctrl.startPreview(ctx)

    expect(ctx.status).toBe(201)
    expect(ctx.body.preview.id).toBe('preview-slot')
    expect(ctx.body.preview.status).toBe('running')
    expect(ctx.body.preview.target).toEqual({
      type: 'docker-image',
      image: 'ghcr.io/kira-project-lab/hermes-web-ui:preview',
    })

    const listCtx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    await ctrl.listPreviews(listCtx)
    expect(listCtx.body.previews).toHaveLength(1)
    expect(listCtx.body.previews[0].id).toBe('preview-slot')

    const detailCtx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    await ctrl.getPreview(detailCtx)
    expect(detailCtx.body.preview.id).toBe('preview-slot')

    const stopCtx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    stopCtx.request.body = { reason: 'QA complete' }
    await ctrl.stopPreview(stopCtx)

    expect(stopCtx.body.preview.status).toBe('stopped')
    expect(stopCtx.body.preview.finishedAt).not.toBeNull()
    expect(stopCtx.body.preview.logTail.at(-1)).toContain('QA complete')
  })

  it('returns a not-found error for an empty singleton slot and validates targets', async () => {
    const missingIdCtx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    await ctrl.getPreview(missingIdCtx)
    expect(missingIdCtx.status).toBe(404)
    expect(missingIdCtx.body).toEqual({
      error: {
        code: 'preview_not_found',
        message: 'Preview instance not found: preview-slot',
        details: null,
      },
    })

    const invalidTargetCtx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    invalidTargetCtx.request.body = { target: { type: 'installed-version' } }
    await ctrl.startPreview(invalidTargetCtx)
    expect(invalidTargetCtx.status).toBe(400)
    expect(invalidTargetCtx.body).toEqual({
      error: {
        code: 'preview_invalid_target',
        message: 'installed-version target requires version',
        details: null,
      },
    })
  })
})
