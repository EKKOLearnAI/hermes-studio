import { ref, watch } from 'vue';
const STORAGE_KEY = 'hermes_theme';
const mode = ref(localStorage.getItem(STORAGE_KEY) || 'system');
const isDark = ref(false);
function applyTheme(dark) {
    isDark.value = dark;
    document.documentElement.classList.toggle('dark', dark);
}
function resolveDark(m) {
    if (m === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return m === 'dark';
}
// Initial resolve
applyTheme(resolveDark(mode.value));
// Listen for system preference changes
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
mediaQuery.addEventListener('change', () => {
    if (mode.value === 'system') {
        applyTheme(resolveDark('system'));
    }
});
// Watch mode changes
watch(mode, (newMode) => {
    localStorage.setItem(STORAGE_KEY, newMode);
    applyTheme(resolveDark(newMode));
});
export function useTheme() {
    function setMode(m) {
        mode.value = m;
    }
    function toggleTheme() {
        mode.value = isDark.value ? 'light' : 'dark';
    }
    return {
        mode,
        isDark,
        setMode,
        toggleTheme,
    };
}
