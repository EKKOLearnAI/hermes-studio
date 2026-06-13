import { logger } from '../logger'
import { getActiveProfileDir } from './hermes-profile'
import { spawnHermesWithBin } from './hermes-process'

interface SupervisedGateway {
  pid: number
  child: ReturnType<typeof spawnHermesWithBin>
  hermesBin: string
  profileDir: string
}

/**
 * Per-profile state for our supervised gateway.
 *
 * - `current` is the most recent child we spawned for this profile. When it
 *   exits, the exit handler clears this slot.
 * - `respawnTimer` is a pending respawn that was scheduled because the
 *   previous child died and no replacement has been started yet. The next
 *   call to `startGatewayRunManaged` for the same profile clears it: a fresh
 *   start is already happening, so a respawn would race with it.
 *
 * This is what makes `/restart` safe. The flow is:
 *   1. `/restart` calls `hermes gateway stop` (CLI) which kills our child.
 *   2. That child's exit handler schedules a respawn timer (step T+0).
 *   3. `/restart` then calls `startGatewayRunManaged` for the same profile.
 *   4. That call clears the pending respawn timer (we're starting a new one
 *      anyway) and registers the fresh child.
 *
 * Net result: exactly one new gateway per `/restart`, no orphans.
 */
interface ProfileState {
  current: SupervisedGateway | null
  respawnTimer: NodeJS.Timeout | null
}

const profileState = new Map<string, ProfileState>()

/** Delay before respawning a gateway that exited unexpectedly. */
const RESPAWN_DELAY_MS = 2000

function getOrCreateProfileState(profileDir: string): ProfileState {
  let state = profileState.get(profileDir)
  if (!state) {
    state = { current: null, respawnTimer: null }
    profileState.set(profileDir, state)
  }
  return state
}

export function startGatewayRunManaged(
  hermesBin: string,
  opts: { profileDir?: string } = {},
): { pid: number | null; reused: boolean } {
  const profileDir = opts.profileDir || getActiveProfileDir()
  const state = getOrCreateProfileState(profileDir)

  // A new spawn for this profile cancels any pending respawn from a previous
  // unexpected exit. Without this, `/restart` (stop -> start) would race
  // against the respawn timer and end up with two gateways on the same port.
  if (state.respawnTimer) {
    clearTimeout(state.respawnTimer)
    state.respawnTimer = null
    logger.info('[gateway-runner] cancelled pending respawn for new start profileDir=%s', profileDir)
  }

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
  if (pid) {
    const entry: SupervisedGateway = { pid, child, hermesBin, profileDir }
    state.current = entry

    child.on('exit', (code, signal) => {
      // Only act if this is still the active child for the profile. A new
      // start for the same profile replaces `state.current` and we don't
      // want the old child's exit to trigger anything.
      if (state.current?.pid !== pid) return
      state.current = null

      logger.warn(
        '[gateway-runner] gateway exited unexpectedly (profileDir=%s pid=%s code=%s signal=%s), respawning in %dms',
        profileDir, pid, code, signal, RESPAWN_DELAY_MS,
      )

      state.respawnTimer = setTimeout(() => {
        state.respawnTimer = null
        try {
          const next = startGatewayRunManaged(hermesBin, { profileDir })
          logger.info(
            '[gateway-runner] gateway respawned (oldPid=%s newPid=%s profileDir=%s)',
            pid, next.pid, profileDir,
          )
        } catch (err) {
          logger.error(err, '[gateway-runner] failed to respawn gateway after unexpected exit')
        }
      }, RESPAWN_DELAY_MS)
      // Don't keep the event loop alive just for a pending respawn.
      state.respawnTimer.unref()
    })
  }

  return { pid, reused: false }
}
