import { expect, it, vi } from 'vitest'
import { createDshHost } from '../../packages/server/src/modules/coding-agents/services/dsh/host'

it('uses the discovered toolchain PATH for ACP and rejects missing DSH before launch', async () => {
  const find = vi.fn().mockResolvedValue(['/tools/dsh'])
  const host = createDshHost({ commandEnv: async () => ({ PATH: '/tools:/pnpm' }), findCommandPaths: find,
    resolveCommandForExecution: async command => command, commandExecution: (command, args) => ({ command, args }), getSourceHome: () => '/native/.dsh' })
  expect(await host.runtimeInput()).toMatchObject({ installationCommand: '/tools/dsh', launchPath: '/tools:/pnpm' })
  find.mockResolvedValue([])
  await expect(host.runtimeInput()).rejects.toMatchObject({ code: 'DSH_DEPENDENCY_UNAVAILABLE' })
})
