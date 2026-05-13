/**
 * 语速倍率 → Edge TTS rate 字符串
 * 1.0 → "0%", 1.2 → "+20%", 0.5 → "-50%"
 */
export function speedToEdgeRate(speed: number): string {
  const percent = Math.round((speed - 1) * 100)
  return percent >= 0 ? `+${percent}%` : `${percent}%`
}

/**
 * Hz 偏移值 → Edge TTS pitch 字符串
 * 0 → "0Hz", 12 → "+12Hz", -8 → "-8Hz"
 */
export function hzToEdgePitch(hz: number): string {
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`
}
