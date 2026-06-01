<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-left">
        <div class="footer-brand">
          <img src="/logo.png" :alt="t('brand.logoAlt')" class="footer-logo" />
          <span>{{ t('brand.name') }}</span>
        </div>
        <p class="footer-desc">{{ t('footer.description') }}</p>
      </div>
      <div class="footer-right">
        <p class="footer-meta">{{ t('footer.madeWith') }}</p>
        <p class="footer-meta">{{ t('footer.license') }}</p>
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

</style>
