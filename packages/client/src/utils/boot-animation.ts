export const BOOT_ANIMATION_MIN_DURATION_MS = 1_800

export function getBootAnimationDelay(
  startedAt: number | undefined,
  now = performance.now(),
): number {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 0

  const elapsed = Math.max(0, now - startedAt)
  return Math.max(0, BOOT_ANIMATION_MIN_DURATION_MS - elapsed)
}

export async function waitForBootAnimation(): Promise<void> {
  const delay = getBootAnimationDelay(window.__HERMES_BOOT_ANIMATION_STARTED_AT__)
  if (delay <= 0) return

  await new Promise<void>(resolve => window.setTimeout(resolve, delay))
}
