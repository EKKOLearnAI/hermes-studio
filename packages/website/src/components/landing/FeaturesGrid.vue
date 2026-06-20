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
  <section class="features-section">
    <div class="features-inner">
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
    </div>
  </section>
</template>

<style scoped lang="scss">
.features-section {
  padding: 82px 18px;
  background: transparent;

  @media (max-width: $breakpoint-mobile) {
    padding: 54px 10px;
  }
}

.features-inner {
  max-width: 1120px;
  margin: 0 auto;
}

.section-title {
  margin: 0 auto 16px;
  color: rgba(30, 38, 52, 0.92);
  font-size: clamp(32px, 4vw, 54px);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.05;
}

.section-desc {
  max-width: 680px;
  margin: 0 auto 36px;
  color: rgba(42, 50, 64, 0.68);
  font-size: 16px;
  line-height: 1.65;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;

  @media (max-width: 900px) {
    grid-template-columns: repeat(2, 1fr);
  }

  @media (max-width: $breakpoint-mobile) {
    grid-template-columns: 1fr;
  }
}

.feature-card {
  min-height: 220px;
  padding: 24px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(248, 250, 253, 0.72));
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 24px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
  transition: transform $transition-normal, border-color $transition-normal, box-shadow $transition-normal, background $transition-normal;

  &:hover {
    border-color: rgba(30, 50, 90, 0.14);
    box-shadow: 0 18px 44px rgba(30, 50, 90, 0.08);
    transform: translateY(-2px);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(248, 250, 253, 0.82));
  }
}

.feature-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(238, 242, 247, 0.82));
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 16px;
  margin-bottom: 18px;
  color: rgba(30, 50, 90, 0.78);
  transition: background $transition-normal, color $transition-normal;

  .feature-card:hover & {
    color: rgba(30, 50, 90, 0.95);
    background: rgba(255, 255, 255, 0.92);
  }

  svg {
    width: 20px;
    height: 20px;
  }
}

.feature-title {
  font-size: 16px;
  font-weight: 650;
  margin-bottom: 9px;
  color: rgba(30, 38, 52, 0.9);
}

.feature-desc {
  font-size: 14px;
  line-height: 1.6;
  color: rgba(42, 50, 64, 0.64);
}
</style>
