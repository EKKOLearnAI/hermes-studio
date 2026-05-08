import { ref, watch } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'hermes_website_theme'

const mode = ref<ThemeMode>(
  (localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'system',
)

const isDark = ref(false)

function applyTheme(dark: boolean) {
  isDark.value = dark
  document.documentElement.classList.toggle('dark', dark)
}

function resolveDark(m: ThemeMode): boolean {
  if (m === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return m === 'dark'
}

applyTheme(resolveDark(mode.value))

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
mediaQuery.addEventListener('change', () => {
  if (mode.value === 'system') {
    applyTheme(resolveDark('system'))
  }
})

watch(mode, (newMode) => {
  localStorage.setItem(STORAGE_KEY, newMode)
  applyTheme(resolveDark(newMode))
})

export function useTheme() {
  function setMode(m: ThemeMode) {
    mode.value = m
  }

  function toggleTheme() {
    mode.value = isDark.value ? 'light' : 'dark'
  }

  return {
    mode,
    isDark,
    setMode,
    toggleTheme,
  }
}
