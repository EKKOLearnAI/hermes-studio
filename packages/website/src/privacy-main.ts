import { createApp } from 'vue'
import { i18n } from './i18n'
import PrivacyApp from './PrivacyApp.vue'
import '@client/styles/variables.scss'
import './styles/global.scss'

localStorage.setItem('hermes_website_theme', 'light')
document.documentElement.classList.remove('dark')

const app = createApp(PrivacyApp)
app.use(i18n)
app.mount('#app')
