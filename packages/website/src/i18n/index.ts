import { createI18n } from 'vue-i18n'
import en from './en'
import zh from './zh'

const detected = navigator.language.startsWith('zh') ? 'zh' : 'en'
const saved = localStorage.getItem('hermes_website_locale')

export const i18n = createI18n({
  legacy: false,
  locale: saved || detected,
  fallbackLocale: 'en',
  messages: { en, zh },
})
