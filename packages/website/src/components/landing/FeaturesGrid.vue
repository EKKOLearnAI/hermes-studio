<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'

const { t } = useI18n()
useScrollReveal()

const features = [
  { key: 'streaming', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { key: 'platforms', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { key: 'multiModel', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 14l-4-4h8l-4 4z' },
  { key: 'groupChat', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { key: 'kanban', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { key: 'analytics', icon: 'M18 20V10M12 20V4M6 20v-6' },
  { key: 'profiles', icon: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z' },
  { key: 'files', icon: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' },
  { key: 'terminal', icon: 'M4 17l6-6-6-6M12 19h8' },
  { key: 'quickInstall', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { key: 'i18n', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 17.93a8 8 0 0 1 0-15.86M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10M2 12h20' },
  { key: 'theme', icon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' },
]
</script>

<template>
  <section class="section">
    <h2 class="section-title reveal">{{ t('features.title') }}</h2>
    <p class="section-desc reveal">{{ t('features.desc') }}</p>
    <div class="features-grid">
      <div
        v-for="(f, i) in features"
        :key="f.key"
        class="feature-card reveal"
        :class="[`reveal-delay-${(i % 4) + 1}`]"
      >
        <div class="feature-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path :d="f.icon" />
          </svg>
        </div>
        <h3 class="feature-title">{{ t(`features.${f.key}.title`) }}</h3>
        <p class="feature-desc">{{ t(`features.${f.key}.desc`) }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;

  @media (max-width: 900px) {
    grid-template-columns: repeat(2, 1fr);
  }

  @media (max-width: $breakpoint-mobile) {
    grid-template-columns: 1fr;
  }
}

.feature-card {
  padding: 28px 24px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  transition: all $transition-normal;

  &:hover {
    border-color: var(--text-muted);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    transform: translateY(-2px);
  }
}

.feature-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border-radius: $radius-sm;
  margin-bottom: 16px;
  color: var(--accent-primary);
  transition: background $transition-normal;

  .feature-card:hover & {
    background: var(--border-color);
  }

  svg {
    width: 20px;
    height: 20px;
  }
}

.feature-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.feature-desc {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
