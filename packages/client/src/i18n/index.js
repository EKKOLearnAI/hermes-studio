import { createI18n } from 'vue-i18n';
import en from './locales/en';
import zh from './locales/zh';
import ja from './locales/ja';
import ko from './locales/ko';
import fr from './locales/fr';
import es from './locales/es';
import de from './locales/de';
import pt from './locales/pt';
const saved = localStorage.getItem('hermes_locale');
const detected = navigator.language.slice(0, 2);
const supportedLocales = ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'pt'];
function resolveLocale(saved, detected) {
    if (saved && supportedLocales.includes(saved)) {
        return saved;
    }
    if (supportedLocales.includes(detected)) {
        return detected;
    }
    return 'en';
}
export const i18n = createI18n({
    legacy: false,
    locale: resolveLocale(saved, detected),
    fallbackLocale: 'en',
    messages: { en, zh, ja, ko, fr, es, de, pt },
});
