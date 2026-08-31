import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverHermesCliInstallations } from '../../packages/server/src/modules/hermes/services/runtime/discovery'

const originalHermesBin = process.env.HERMES_BIN
const temporaryDirectories: string[] = []

function createCli(directory: string, version: string): string {
  mkdirSync(directory, { recursive: true })
  const python = join(directory, 'python3')
  writeFileSync(python, `#!/bin/sh\nprintf '${version}\\n'\n`)
  chmodSync(python, 0o755)
  const cli = join(directory, 'hermes')
  writeFileSync(cli, '#!/bin/sh\nexit 97\n')
  chmodSync(cli, 0o755)
  return cli
}

afterEach(() => {
  if (originalHermesBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = originalHermesBin
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Hermes CLI discovery', () => {
  it.skipIf(process.platform === 'win32')('separates managed Runtime CLIs from user-owned CLIs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-cli-discovery-'))
    temporaryDirectories.push(root)
    const managedRuntime = join(root, 'runtime', '0.21.0', 'test-platform')
    const managedBin = join(managedRuntime, 'python', 'bin')
    const userBin = join(root, 'user-bin')
    const managedCli = createCli(managedBin, '0.21.0')
    const userCli = createCli(userBin, '0.20.4')
    process.env.HERMES_BIN = managedCli

    const installations = await discoverHermesCliInstallations(
      [{ version: '0.21.0', directory: managedRuntime }],
      {
        ...process.env,
        PATH: [managedBin, userBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    )

    expect(installations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: managedCli,
        version: '0.21.0',
        source: 'managed-runtime',
        selected: true,
        managedRuntimeVersion: '0.21.0',
      }),
      expect.objectContaining({
        path: userCli,
        version: '0.20.4',
        source: 'user-cli',
        selected: false,
      }),
    ]))
  })
})
