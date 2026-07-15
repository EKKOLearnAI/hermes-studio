export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return true

  const hasTouch = navigator.maxTouchPoints > 1
  const pointerQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse), (any-pointer: coarse)')
    : null
  const hasCoarsePointer = Boolean(pointerQuery?.matches)
  const screenShortEdge = typeof window !== 'undefined' && window.screen
    ? Math.min(window.screen.width, window.screen.height)
    : Number.POSITIVE_INFINITY

  // "Request desktop site" can replace the mobile UA entirely. Physical
  // touch/pointer/screen traits still distinguish the phone from a PC.
  return hasTouch && hasCoarsePointer && screenShortEdge <= 1024
}
