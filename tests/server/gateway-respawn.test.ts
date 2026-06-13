import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

class FakeChild extends EventEmitter {
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  unref() { /* no-op */ }
  kill() { return true }
}

let fakeChildren: FakeChild[] = []

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  resolveHermesInvocation: (bin: string) => ({ command: bin, argsPrefix: [] }),
  execHermesWithBin: vi.fn(),
  execHermes: vi.fn(),
  spawnHermesWithBin: vi.fn(() => {
    const pid = 10000 + fakeChildren.length
    const child = new FakeChild(pid)
    fakeChildren.push(child)
    return child
  }),
  spawnHermes: vi.fn(),
  resolveHermesBin: () => 'hermes',
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
  fakeChildren = []
})

describe('gateway-runner supervision', () => {
  it('respawns the gateway when the spawned child dies unexpectedly', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )

    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-a' })
    expect(first.pid).toBe(10000)
    expect(fakeChildren).toHaveLength(1)

    // Simulate unexpected exit
    fakeChildren[0].emit('exit', 1, null)

    // No respawn yet — timer is pending
    expect(fakeChildren).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2500)

    // A new spawn should have been issued
    expect(fakeChildren.length).toBeGreaterThanOrEqual(2)
    const newPid = fakeChildren[fakeChildren.length - 1].pid
    expect(newPid).not.toBe(10000)

    vi.useRealTimers()
  })

  it('cancels a pending respawn when a fresh start is issued for the same profile (the /restart case)', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )

    // First start: a gateway is running
    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-b' })
    expect(first.pid).toBe(10000)

    // Simulate `/restart`: old gateway dies, then a new start happens before
    // the respawn timer fires.
    fakeChildren[0].emit('exit', 1, null)
    expect(fakeChildren).toHaveLength(1) // respawn not yet fired

    // New start (the `/restart` second phase) for the same profile. The
    // pending respawn timer should be cancelled.
    const second = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-b' })
    expect(second.pid).toBe(10001)
    expect(fakeChildren).toHaveLength(2)

    // Now advance timers past the original respawn delay. The cancelled
    // respawn must NOT fire — otherwise we'd have a third gateway racing
    // with the second.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fakeChildren).toHaveLength(2)

    vi.useRealTimers()
  })

  it('tracks respawns independently per profile', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )

    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/profile-x' })
    startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/profile-y' })
    expect(fakeChildren).toHaveLength(2)

    // profile-x's gateway dies — only its respawn timer should fire
    fakeChildren[0].emit('exit', 1, null)

    await vi.advanceTimersByTimeAsync(2500)

    // profile-x was respawned (3rd child), profile-y was untouched
    expect(fakeChildren).toHaveLength(3)
    expect(fakeChildren[2].pid).toBe(10002)

    vi.useRealTimers()
  })

  it('does not respawn if a new start for the same profile has already replaced the dead child', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { startGatewayRunManaged } = await import(
      '../../packages/server/src/services/hermes/gateway-runner'
    )

    const first = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-c' })
    fakeChildren[0].emit('exit', 0, 'SIGTERM')

    // Issue a fresh start BEFORE the respawn timer fires — this clears the
    // pending respawn. The old child's exit handler then becomes a no-op
    // because `state.current?.pid !== oldPid` after the new start.
    const second = startGatewayRunManaged('/usr/bin/hermes', { profileDir: '/tmp/fake-c' })
    expect(second.pid).not.toBe(first.pid)

    // Now the original (now-orphaned) exit listener fires after the timer
    // window. It should detect the mismatch and not schedule another spawn.
    await vi.advanceTimersByTimeAsync(5000)

    // Exactly two children total: the original, and the replacement
    expect(fakeChildren).toHaveLength(2)

    vi.useRealTimers()
  })
})
