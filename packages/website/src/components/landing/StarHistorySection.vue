<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useTheme } from '@/composables/useTheme'

const { t } = useI18n()
const { isDark } = useTheme()
useScrollReveal()

const stars = ref<number | null>(null)

const chartSrc = computed(() => {
  const base = 'https://api.star-history.com/svg?repos=EKKOLearnAI%2Fhermes-web-ui&type=Date'
  return isDark.value ? `${base}&theme=dark` : base
})

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/EKKOLearnAI/hermes-web-ui')
    const data = await res.json()
    stars.value = data.stargazers_count
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
        <span>Star</span>
        <span v-if="stars !== null" class="star-count">{{ stars.toLocaleString() }}</span>
      </a>

      <img
        class="github-badge"
        src="https://img.shields.io/github/license/EKKOLearnAI/hermes-web-ui?style=flat-square"
        alt="License"
      />
      <img
        class="github-badge"
        src="https://img.shields.io/github/v/release/EKKOLearnAI/hermes-web-ui?style=flat-square"
        alt="Version"
      />
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
          alt="Star History"
          class="chart-img"
        />
      </a>
    </div>
  </div>
</template>

<style scoped lang="scss">
.star-panel {
  padding: 40px 32px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-lg;
  display: flex;
  flex-direction: column;

  @media (max-width: $breakpoint-mobile) {
    padding: 24px 16px;
  }
}

.panel-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.panel-desc {
  color: var(--text-secondary);
  font-size: 15px;
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
  padding: 6px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  text-decoration: none;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  transition: all $transition-fast;

  &:hover {
    border-color: var(--text-muted);
  }
}

.star-icon {
  width: 16px;
  height: 16px;
  fill: var(--text-muted);
}

.star-count {
  padding: 1px 8px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  border-radius: 0 $radius-sm $radius-sm 0;
  margin-left: 2px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.github-badge {
  height: 22px;
  border-radius: 2px;
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
  border-radius: $radius-sm;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }
}
</style>
