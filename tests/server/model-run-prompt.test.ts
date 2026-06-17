import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const issueModelRunJwtMock = vi.hoisted(() => vi.fn(async () => 'model-run-token'))
const homes: string[] = []

vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

describe('model run prompt', () => {
  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('stores the model-run token under the profile and keeps the token out of the prompt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-model-run-prompt-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home

    const { writeModelRunProfileToken, modelRunProfileTokenPath } = await import('../../packages/server/src/services/hermes/run-chat/model-run-prompt')
    await writeModelRunProfileToken({ id: 1, username: 'admin', role: 'super_admin' }, 'default')
    const tokenPath = modelRunProfileTokenPath('default')

    expect(issueModelRunJwtMock).toHaveBeenCalledWith({ id: 1, username: 'admin', role: 'super_admin' })
    expect(tokenPath).toBe(join(home, 'profiles', 'default', '.model-run-token'))
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe('model-run-token')
  })

  it('returns profile instructions without writing a token for anonymous runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-model-run-prompt-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home

    const { writeModelRunProfileToken, modelRunProfileTokenPath } = await import('../../packages/server/src/services/hermes/run-chat/model-run-prompt')
    await writeModelRunProfileToken(undefined, 'research')

    expect(existsSync(modelRunProfileTokenPath('research'))).toBe(false)
  })
})
