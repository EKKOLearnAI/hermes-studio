import { afterEach, describe, expect, it, vi } from 'vitest'

const originalContainer = process.env.container

async function loadRuntimeEnvironment(
  options: { dockerEnvFile?: boolean; container?: string } = {},
) {
  vi.resetModules()
  if (options.container === undefined) delete process.env.container
  else process.env.container = options.container
  const existsSync = vi.fn((path: string) => path === '/.dockerenv' && options.dockerEnvFile === true)
  vi.doMock('fs', () => ({ existsSync }))
  const runtimeEnvironment = await import('../../packages/server/src/services/runtime-environment')
  return { ...runtimeEnvironment, existsSync }
}

describe('runtime environment detection', () => {
  afterEach(() => {
    vi.doUnmock('fs')
    vi.resetModules()
    if (originalContainer === undefined) delete process.env.container
    else process.env.container = originalContainer
  })

  it('does not classify a regular Web UI process as Docker', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment()

    expect(isDockerContainer()).toBe(false)
  })

  it('detects the Docker environment marker file', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment({ dockerEnvFile: true })

    expect(isDockerContainer()).toBe(true)
  })

  it('detects the Docker container environment variable', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment({ container: 'docker' })

    expect(isDockerContainer()).toBe(true)
  })
})
