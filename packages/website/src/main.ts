import { createApp } from 'vue'
import router from './router'
import { i18n } from './i18n'
import App from './App.vue'
// Import CSS custom properties (theme variables) from client
import '@client/styles/variables.scss'
import './styles/global.scss'

const savedTheme = localStorage.getItem('hermes_website_theme') || 'system'
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (savedTheme === 'dark' || (savedTheme === 'system' && prefersDark)) {
  document.documentElement.classList.add('dark')
}

const app = createApp(App)
app.use(i18n)
app.use(router)
app.mount('#app')
