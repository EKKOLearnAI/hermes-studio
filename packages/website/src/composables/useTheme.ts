import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'hermes_website_theme'

const mode = ref<ThemeMode>('light')
const isDark = ref(false)

localStorage.setItem(STORAGE_KEY, 'light')
document.documentElement.classList.remove('dark')

export function useTheme() {
  function setMode(_m: ThemeMode) {
    mode.value = 'light'
    localStorage.setItem(STORAGE_KEY, 'light')
    document.documentElement.classList.remove('dark')
  }

  function toggleTheme() {
    setMode('light')
  }

  return {
    mode,
    isDark,
    setMode,
    toggleTheme,
  }
}
