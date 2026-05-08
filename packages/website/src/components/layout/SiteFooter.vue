<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-left">
        <div class="footer-brand">
          <img src="/logo.png" alt="Hermes" class="footer-logo" />
          <span>Hermes Web UI</span>
        </div>
        <p class="footer-desc">{{ t('footer.description') }}</p>
      </div>
      <div class="footer-right">
        <p class="footer-meta">{{ t('footer.madeWith') }}</p>
        <p class="footer-meta">{{ t('footer.license') }}</p>
        <a
          class="footer-github"
          href="https://github.com/EKKOLearnAI/hermes-web-ui"
          target="_blank"
          rel="noopener"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        </a>
      </div>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.site-footer {
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.footer-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 40px 24px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 40px;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
    gap: 24px;
  }
}

.footer-left {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text-primary);
}

.footer-logo {
  width: 24px;
  height: 24px;
  border-radius: $radius-sm;
}

.footer-desc {
  color: var(--text-muted);
  font-size: 13px;
}

.footer-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;

  @media (max-width: $breakpoint-mobile) {
    align-items: flex-start;
  }
}

.footer-meta {
  color: var(--text-muted);
  font-size: 13px;
}

.footer-github {
  color: var(--text-muted);
  transition: color $transition-fast;

  &:hover {
    color: var(--text-primary);
  }

  svg {
    width: 20px;
    height: 20px;
  }
}
</style>
