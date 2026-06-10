<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
const copied = ref(false)
const installCmd = 'npm install -g hermes-web-ui'
const releaseVersion = __WEBSITE_DOWNLOAD_VERSION__.replace(/^v/, '')

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(installCmd)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {}
}

function goDocs() {
  router.push({ name: 'docs.getting-started' })
}

function scrollToDownload() {
  document.getElementById('download')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <section class="hero-shell">
    <div class="hero-panel">
      <div class="hero-bg">
        <img src="/image1.png" :alt="t('hero.previewAlt')" />
      </div>
      <div class="hero-overlay" />

      <div class="hero-content">
        <div class="hero-badge animate-fade-in-up">
          <span class="status-dot" />
          <span>{{ t('hero.badge') }}</span>
        </div>

        <h1 class="hero-title animate-fade-in-up animate-delay-1">{{ t('hero.title') }}</h1>
        <p class="hero-subtitle animate-fade-in-up animate-delay-2">{{ t('hero.subtitle') }}</p>

        <div class="hero-actions animate-fade-in-up animate-delay-3">
          <button class="primary-cta" type="button" @click="scrollToDownload">
            {{ t('hero.cta') }}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
          </button>
          <button class="secondary-cta" type="button" @click="goDocs">
            {{ t('hero.docsCta') }}
          </button>
        </div>

        <div class="hero-meta animate-fade-in animate-delay-4">
          <button class="install-command" type="button" @click="copyCmd">
            <code>{{ installCmd }}</code>
            <span>{{ copied ? t('ui.copied') : t('ui.copy') }}</span>
          </button>
          <div class="release-chip">
            <strong>{{ releaseVersion }}</strong>
            <span>{{ t('hero.latestRelease') }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.hero-shell {
  width: 100%;
  padding: 18px 18px 0;
  background: #f7f8fa;
  display: flex;
  justify-content: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 10px 10px 0;
  }
}

.hero-panel {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-width: 1536px;
  min-height: min(720px, calc(100svh - 104px));
  border-radius: 34px;
  background: #eef1f4;
  border: 1px solid rgba(30, 50, 90, 0.08);
  isolation: isolate;

  @media (max-width: $breakpoint-mobile) {
    min-height: 650px;
    border-radius: 24px;
  }
}

.hero-bg {
  position: absolute;
  inset: auto 4% -8% 4%;
  height: 58%;
  border-radius: 24px 24px 0 0;
  overflow: hidden;
  border: 1px solid rgba(30, 50, 90, 0.1);
  box-shadow:
    0 24px 80px rgba(30, 50, 90, 0.16),
    0 4px 24px rgba(30, 50, 90, 0.08);
  z-index: -2;

  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    object-position: top center;
    filter: saturate(0.94) contrast(0.96);
  }

  @media (max-width: $breakpoint-mobile) {
    inset: auto 12px -4% 12px;
    height: 45%;
    border-radius: 18px 18px 0 0;
  }
}

.hero-overlay {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: min(64%, 500px);
  z-index: -1;
  background:
    radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.86), rgba(255, 255, 255, 0) 58%),
    linear-gradient(180deg, rgba(238, 241, 244, 0.96) 0%, rgba(238, 241, 244, 0.82) 55%, rgba(238, 241, 244, 0) 100%);
  pointer-events: none;

  @media (min-width: 1600px) {
    height: 460px;
  }
}

.hero-content {
  width: min(100%, 920px);
  margin: 0 auto;
  padding: clamp(58px, 9vh, 92px) 24px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 44px 18px 0;
  }
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  width: fit-content;
  margin-bottom: 16px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  background: rgba(255, 255, 255, 0.66);
  color: rgba(30, 50, 90, 0.76);
  backdrop-filter: blur(14px);
  font-size: 13px;
  font-weight: 650;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #35c67a;
  box-shadow: 0 0 0 5px rgba(53, 198, 122, 0.12);
}

.hero-title {
  max-width: 760px;
  margin: 0;
  color: rgba(30, 38, 52, 0.92);
  font-size: clamp(50px, 7vw, 92px);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 0.98;

  @media (max-width: $breakpoint-mobile) {
    font-size: clamp(42px, 13vw, 62px);
  }
}

.hero-subtitle {
  max-width: 660px;
  margin: 20px 0 0;
  color: rgba(42, 50, 64, 0.7);
  font-size: clamp(15px, 1.35vw, 18px);
  line-height: 1.68;
  font-weight: 450;
}

.hero-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 26px;
}

.primary-cta,
.secondary-cta {
  min-height: 44px;
  border-radius: 999px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: transform $transition-fast, background $transition-fast, border-color $transition-fast;
}

.primary-cta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 0;
  background: rgba(30, 50, 90, 0.92);
  color: #fff;

  svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    background: rgba(30, 50, 90, 1);
    transform: translateY(-1px);
  }
}

.secondary-cta {
  border: 1px solid rgba(30, 50, 90, 0.12);
  background: rgba(255, 255, 255, 0.62);
  color: rgba(30, 50, 90, 0.82);
  backdrop-filter: blur(14px);

  &:hover {
    border-color: rgba(30, 50, 90, 0.24);
    background: rgba(255, 255, 255, 0.84);
    transform: translateY(-1px);
  }
}

.hero-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
}

.install-command {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 56px);
  border: 1px solid rgba(30, 50, 90, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.64);
  color: rgba(30, 50, 90, 0.82);
  padding: 8px 9px 8px 16px;
  backdrop-filter: blur(14px);
  cursor: pointer;

  code {
    padding: 0;
    background: transparent;
    color: inherit;
    white-space: nowrap;
    font-size: 13px;
  }

  span {
    flex: 0 0 auto;
    border-radius: 999px;
    background: rgba(30, 50, 90, 0.08);
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 700;
  }

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
    justify-content: space-between;
    border-radius: 16px;

    code {
      overflow-x: auto;
    }
  }
}

.release-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  border-radius: 999px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  background: rgba(255, 255, 255, 0.54);
  color: rgba(30, 50, 90, 0.7);
  padding: 8px 13px;
  backdrop-filter: blur(14px);

  strong {
    color: rgba(30, 50, 90, 0.9);
    font-size: 13px;
  }

  span {
    font-size: 12px;
    font-weight: 650;
  }
}
</style>
