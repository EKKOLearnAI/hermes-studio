<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useTheme } from '@/composables/useTheme'

const { t, locale } = useI18n()
const router = useRouter()
const { isDark, toggleTheme } = useTheme()
const mobileMenuOpen = ref(false)
const showQQModal = ref(false)

function switchLocale() {
  const next = locale.value === 'en' ? 'zh' : 'en'
  locale.value = next
  localStorage.setItem('hermes_website_locale', next)
}

function navigateTo(name: string) {
  router.push({ name })
  mobileMenuOpen.value = false
}

function goHome() {
  router.push({ name: 'landing' })
  mobileMenuOpen.value = false
}
</script>

<template>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-left" @click="goHome">
        <img src="/logo.png" alt="Hermes" class="logo-icon" />
        <span class="logo-text">Hermes Web UI</span>
      </div>

      <nav class="header-nav">
        <a class="nav-link" @click.prevent="navigateTo('landing')">{{ t('nav.home') }}</a>
        <a class="nav-link" @click.prevent="navigateTo('docs.getting-started')">{{ t('nav.docs') }}</a>
        <a
          class="nav-link"
          href="https://github.com/EKKOLearnAI/hermes-web-ui"
          target="_blank"
          rel="noopener"
        >
          {{ t('nav.github') }}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="external-icon">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
        <a class="nav-link" @click.prevent="showQQModal = true">
          {{ t('nav.qqGroup') }}
        </a>
        <button class="icon-btn" @click="switchLocale" :title="locale === 'en' ? '中文' : 'English'">
          {{ locale === 'en' ? '中' : 'EN' }}
        </button>
        <button class="icon-btn" @click="toggleTheme" :title="isDark ? 'Light' : 'Dark'">
          <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>
      </nav>

      <button class="mobile-toggle" @click="mobileMenuOpen = !mobileMenuOpen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </div>

    <div v-if="mobileMenuOpen" class="mobile-menu" @click="mobileMenuOpen = false">
      <div class="mobile-menu-inner" @click.stop>
        <a class="mobile-link" @click.prevent="navigateTo('landing')">{{ t('nav.home') }}</a>
        <a class="mobile-link" @click.prevent="navigateTo('docs.getting-started')">{{ t('nav.docs') }}</a>
        <a class="mobile-link" href="https://github.com/EKKOLearnAI/hermes-web-ui" target="_blank" rel="noopener">{{ t('nav.github') }}</a>
        <a class="mobile-link" @click.prevent="showQQModal = true; mobileMenuOpen = false">{{ t('nav.qqGroup') }}</a>
        <div class="mobile-actions">
          <button class="mobile-action-btn" @click="switchLocale">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            {{ locale === 'en' ? '中文' : 'English' }}
          </button>
          <button class="mobile-action-btn" @click="toggleTheme">
            <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="action-icon">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            {{ isDark ? 'Light Mode' : 'Dark Mode' }}
          </button>
        </div>
      </div>
    </div>
  </header>
  <Teleport to="body">
    <div v-if="showQQModal" class="qq-modal-overlay" @click="showQQModal = false">
      <div class="qq-modal-content" @click.stop>
        <h3 class="qq-modal-title">{{ t('nav.qqGroup') }}</h3>
        <img src="/qrcode.png" alt="QQ Group" class="qq-modal-qr" />
        <button class="qq-modal-close" @click="showQQModal = false">&times;</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.site-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
}

.header-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-weight: 600;
  font-size: 16px;
  color: var(--text-primary);

  &:hover {
    opacity: 0.8;
  }
}

.logo-icon {
  width: 28px;
  height: 28px;
  border-radius: $radius-sm;
}

.logo-text {
  white-space: nowrap;
}

.header-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-link {
  padding: 6px 14px;
  border-radius: $radius-sm;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all $transition-fast;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }
}

.external-icon {
  width: 12px;
  height: 12px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all $transition-fast;

  &:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
    background: var(--bg-secondary);
  }

  svg {
    width: 16px;
    height: 16px;
  }
}

.mobile-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;

  svg {
    width: 20px;
    height: 20px;
  }
}

.mobile-menu {
  position: fixed;
  inset: 0;
  top: 60px;
  background: rgba(0, 0, 0, 0.3);
  z-index: 99;
}

.mobile-menu-inner {
  background: var(--bg-card);
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
}

.mobile-link {
  padding: 12px 0;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-light);

  &:hover {
    color: var(--text-primary);
  }
}

.mobile-actions {
  display: flex;
  gap: 8px;
  padding-top: 12px;
}

.mobile-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;

  &:active {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }
}

.action-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .header-nav {
    display: none;
  }

  .mobile-toggle {
    display: flex;
  }
}
</style>

<style lang="scss">
.qq-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qq-modal-content {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qq-modal-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.qq-modal-qr {
  width: 260px;
  height: 260px;
  border-radius: 4px;
  object-fit: contain;
}

.qq-modal-close {
  position: absolute;
  top: 8px;
  right: 12px;
  background: none;
  border: none;
  font-size: 24px;
  color: var(--text-muted);
  cursor: pointer;
  line-height: 1;
}

.qq-modal-close:hover {
  color: var(--text-primary);
}
</style>
