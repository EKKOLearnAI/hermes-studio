import { getActiveProfileDir } from './hermes-profile'
import { spawnHermesWithBin } from './hermes-process'

export function startGatewayRunManaged(
  hermesBin: string,
  opts: { profileDir?: string } = {},
): { pid: number | null; reused: boolean } {
  const profileDir = opts.profileDir || getActiveProfileDir()
  const child = spawnHermesWithBin(hermesBin, ['gateway', 'run', '--replace'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HERMES_HOME: profileDir,
    },
  })
  child.unref()

  const pid = child.pid ?? null
  return { pid, reused: false }
}
