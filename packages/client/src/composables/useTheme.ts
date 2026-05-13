import { ref, watch, computed } from 'vue'

export type BrightnessMode = 'light' | 'dark' | 'system'
export type ThemeStyle = 'ink' | 'comic'

const BRIGHTNESS_KEY = 'hermes_brightness'
const STYLE_KEY = 'hermes_style'

const brightness = ref<BrightnessMode>(
  (localStorage.getItem(BRIGHTNESS_KEY) as BrightnessMode) || 'system',
)

const style = ref<ThemeStyle>(
  (localStorage.getItem(STYLE_KEY) as ThemeStyle) || 'ink',
)

const isDark = ref(false)
const isComic = ref(false)

function resolveDark(b: BrightnessMode): boolean {
  if (b === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return b === 'dark'
}

function applyClasses() {
  const dark = resolveDark(brightness.value)
  isDark.value = dark
  isComic.value = style.value === 'comic'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('comic', isComic.value)
}

// Initial
applyClasses()

// Listen for system preference changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (brightness.value === 'system') {
    applyClasses()
  }
})

// Persist & apply on change
watch(brightness, (b) => {
  localStorage.setItem(BRIGHTNESS_KEY, b)
  applyClasses()
})

watch(style, (s) => {
  localStorage.setItem(STYLE_KEY, s)
  applyClasses()
})

export function useTheme() {
  const themeName = computed(() => {
    const b = isDark.value ? 'dark' : 'light'
    return isComic.value ? `comic-${b}` : b
  })

  function setBrightness(b: BrightnessMode) {
    brightness.value = b
  }

  function setStyle(s: ThemeStyle) {
    style.value = s
  }

  function toggleBrightness() {
    brightness.value = isDark.value ? 'light' : 'dark'
  }

  function toggleStyle() {
    style.value = isComic.value ? 'ink' : 'comic'
  }

  return {
    brightness,
    style,
    isDark,
    isComic,
    themeName,
    setBrightness,
    setStyle,
    toggleBrightness,
    toggleStyle,
  }
}
