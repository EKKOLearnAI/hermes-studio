import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { normalizeLegacyRoutePath } from './router/legacy-routing'
import { i18n } from './i18n'
import App from './App.vue'
import './styles/global.scss'
import 'katex/dist/katex.min.css'

// Apply theme classes before mount to prevent FOUC (Flash of Unstyled Content)
const savedBrightness = localStorage.getItem('hermes_brightness') || 'system'
const savedStyle = localStorage.getItem('hermes_style') || 'ink'

// Resolve dark mode
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const isDark = savedBrightness === 'dark' || (savedBrightness === 'system' && prefersDark)

// Resolve style
const isComic = savedStyle === 'comic'

// Apply classes to prevent FOUC
if (isDark) {
  document.documentElement.classList.add('dark')
}
if (isComic) {
  document.documentElement.classList.add('comic')
}

const legacyHashRedirect = normalizeLegacyRoutePath(window.location.hash)
const currentSearch = new URLSearchParams(window.location.search)
const hashQuery = window.location.hash.split('?')[1]
const hashParams = hashQuery ? new URLSearchParams(hashQuery) : null
const urlToken = currentSearch.get('token') || (hashParams ? hashParams.get('token') : null)
if (urlToken) {
  ;(window as any).__LOGIN_TOKEN__ = urlToken
}

if (legacyHashRedirect) {
  const [pathname, queryString = ''] = legacyHashRedirect.split('?')
  if (queryString) {
    const legacyQuery = new URLSearchParams(queryString)
    legacyQuery.forEach((value, key) => {
      currentSearch.set(key, value)
    })
  }
  const search = currentSearch.toString()
  window.history.replaceState(null, '', `${pathname}${search ? `?${search}` : ''}`)
}

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)
app.mount('#app')
