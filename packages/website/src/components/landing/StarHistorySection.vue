<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useTheme } from '@/composables/useTheme'

const { t } = useI18n()
const { isDark } = useTheme()
useScrollReveal()

const stars = ref<number | null>(null)
const releaseVersion = __WEBSITE_DOWNLOAD_VERSION__

const chartSrc = computed(() => {
  const base = 'https://api.star-history.com/svg?repos=EKKOLearnAI%2Fhermes-web-ui&type=Date'
  return isDark.value ? `${base}&theme=dark` : base
})

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/EKKOLearnAI/hermes-web-ui')
    const data = await res.json()
    stars.value = Number.isFinite(data.stargazers_count) ? data.stargazers_count : null
  } catch {}
})
</script>

<template>
  <div class="star-panel">
    <h2 class="panel-title reveal">{{ t('starHistory.title') }}</h2>
    <p class="panel-desc reveal">{{ t('starHistory.desc') }}</p>

    <div class="star-badges reveal reveal-delay-1">
      <a
        class="star-btn"
        href="https://github.com/EKKOLearnAI/hermes-web-ui"
        target="_blank"
        rel="noopener"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" class="star-icon">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
        <span>{{ t('starHistory.star') }}</span>
        <span v-if="stars !== null" class="star-count">{{ stars.toLocaleString() }}</span>
      </a>

      <span class="meta-pill">{{ t('footer.license') }}</span>
      <span class="meta-pill">{{ releaseVersion }}</span>
    </div>

    <div class="star-chart reveal reveal-delay-2">
      <a
        href="https://www.star-history.com/?type=date&repos=EKKOLearnAI%2Fhermes-web-ui"
        target="_blank"
        rel="noopener noreferrer"
        class="chart-link"
      >
        <img
          :src="chartSrc"
          :alt="t('starHistory.chartAlt')"
          class="chart-img"
        />
      </a>
    </div>
  </div>
</template>

<style scoped lang="scss">
.star-panel {
  position: relative;
  overflow: hidden;
  padding: clamp(28px, 4vw, 44px);
  background:
    radial-gradient(circle at 86% 10%, rgba(68, 111, 174, 0.13), rgba(68, 111, 174, 0) 30%),
    radial-gradient(circle at 12% 22%, rgba(229, 185, 77, 0.14), rgba(229, 185, 77, 0) 28%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.84), rgba(247, 249, 252, 0.74));
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 34px;
  box-shadow:
    0 24px 80px rgba(30, 50, 90, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.82);
  display: flex;
  flex-direction: column;

  @media (max-width: $breakpoint-mobile) {
    padding: 22px 14px;
    border-radius: 24px;
  }
}

.panel-title {
  margin: 0 0 10px;
  color: rgba(30, 38, 52, 0.92);
  font-size: clamp(28px, 3vw, 42px);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.06;
}

.panel-desc {
  color: rgba(42, 50, 64, 0.66);
  font-size: 15px;
  line-height: 1.65;
  margin-bottom: 24px;
}

.star-badges {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.star-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 7px 14px;
  background: rgba(30, 50, 90, 0.9);
  border: 1px solid rgba(30, 50, 90, 0.12);
  border-radius: 999px;
  text-decoration: none;
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  box-shadow: 0 8px 22px rgba(30, 50, 90, 0.16);
  transition: transform $transition-fast, background $transition-fast;

  &:hover {
    transform: translateY(-1px);
    background: rgba(30, 50, 90, 1);
    color: #fff;
  }
}

.star-icon {
  width: 16px;
  height: 16px;
  fill: rgba(255, 255, 255, 0.86);
}

.star-count {
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  margin-left: 2px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.meta-pill {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.64);
  color: rgba(30, 50, 90, 0.66);
  font-size: 13px;
  font-weight: 650;
  backdrop-filter: blur(14px);
}

.star-chart {
  flex: 1;
  display: flex;
  align-items: center;
}

.chart-link {
  display: block;
  width: 100%;
}

.chart-img {
  width: 100%;
  border-radius: 22px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  background: rgba(255, 255, 255, 0.62);
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }
}
</style>
