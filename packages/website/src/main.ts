import { createApp } from 'vue'
import router from './router'
import { i18n } from './i18n'
import App from './App.vue'
// Import CSS custom properties (theme variables) from client
import '@client/styles/variables.scss'
import './styles/global.scss'

localStorage.setItem('hermes_website_theme', 'light')
document.documentElement.classList.remove('dark')

const app = createApp(App)
app.use(i18n)
app.use(router)
app.mount('#app')
