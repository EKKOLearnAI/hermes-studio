<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useScrollReveal } from '@/composables/useScrollReveal'

interface DesktopDownload {
  title: string
  desc: string
  assetSuffix: string
}

const { t, tm } = useI18n()
useScrollReveal()
const activeTab = ref<'desktop' | 'npm' | 'docker' | 'source'>('desktop')

const releaseVersion = __WEBSITE_DOWNLOAD_VERSION__.replace(/^v/, '')
const releaseTag = `v${releaseVersion}`
const releaseBaseUrl = 'https://github.com/EKKOLearnAI/hermes-web-ui/releases'
const releaseUrl = `${releaseBaseUrl}/tag/${releaseTag}`
const githubDownloadUrl = `${releaseBaseUrl}/download/${releaseTag}`
const cloudflareDownloadUrl = `https://download.ekkolearnai.com/${releaseTag}`
const desktopDownloads = computed(() =>
  (tm('install.desktop.downloads') as DesktopDownload[]).map((item) => {
    const assetName = `Hermes.Studio-${releaseVersion}-${item.assetSuffix}`
    return {
      ...item,
      githubHref: `${githubDownloadUrl}/${assetName}`,
      cloudflareHref: `${cloudflareDownloadUrl}/${assetName}`,
    }
  }),
)

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {})
}
</script>

<template>
  <div class="install-panel">
    <div class="install-glow" />
    <div class="install-header">
      <div class="install-copy">
        <div class="install-eyebrow reveal">
          <span class="status-dot" />
          <span>v{{ releaseVersion }} · {{ t('hero.latestRelease') }}</span>
        </div>
        <h2 class="panel-title reveal">{{ t('install.title') }}</h2>
        <p class="panel-desc reveal">{{ t('install.desc') }}</p>
      </div>
      <div class="install-mark reveal reveal-delay-1" aria-hidden="true">
        <img src="/logo.png" alt="" />
      </div>
    </div>

    <div class="install-tabs reveal">
      <button
        v-for="tab in (['desktop', 'npm', 'docker', 'source'] as const)"
        :key="tab"
        class="tab-btn"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ t(`install.${tab}.title`) }}
      </button>
    </div>

    <div class="install-content reveal reveal-delay-1">
      <template v-if="activeTab === 'desktop'">
        <div class="download-list">
          <div
            v-for="item in desktopDownloads"
            :key="item.githubHref"
            class="download-row"
          >
            <span>
              <strong>{{ item.title }}</strong>
              <small>{{ item.desc }}</small>
            </span>
            <span class="download-actions">
              <a
                class="download-action"
                :href="item.githubHref"
                target="_blank"
                rel="noopener"
              >
                {{ t('install.desktop.githubDownload') }}
              </a>
              <a
                class="download-action"
                :href="item.cloudflareHref"
                target="_blank"
                rel="noopener"
              >
                {{ t('install.desktop.cloudflareDownload') }}
              </a>
            </span>
          </div>
        </div>
        <a
          class="all-downloads"
          :href="releaseUrl"
          target="_blank"
          rel="noopener"
        >
          {{ t('install.desktop.allDownloads') }}
        </a>
      </template>
      <template v-else-if="activeTab === 'npm'">
        <div class="code-block" @click="copyText(t('install.npm.cmd1'))">
          <code>{{ t('install.npm.cmd1') }}</code>
        </div>
        <div class="code-block" @click="copyText(t('install.npm.cmd2'))">
          <code>{{ t('install.npm.cmd2') }}</code>
        </div>
      </template>
      <template v-else-if="activeTab === 'docker'">
        <div class="code-block" @click="copyText(t('install.docker.cmd'))">
          <code>{{ t('install.docker.cmd') }}</code>
        </div>
      </template>
      <template v-else>
        <div class="code-block" @click="copyText(t('install.source.cmd1'))">
          <code>{{ t('install.source.cmd1') }}</code>
        </div>
        <div class="code-block" @click="copyText(t('install.source.cmd2'))">
          <code>{{ t('install.source.cmd2') }}</code>
        </div>
      </template>
      <p class="prereq">{{ activeTab === 'desktop' ? t('install.desktop.prereq') : t('install.prereq') }}</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.install-panel {
  position: relative;
  isolation: isolate;
  max-width: 1120px;
  margin: 0 auto;
  overflow: hidden;
  padding: clamp(28px, 4vw, 44px);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.82) 0%, rgba(247, 249, 252, 0.72) 54%, rgba(238, 242, 247, 0.82) 100%);
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 34px;
  box-shadow:
    0 24px 80px rgba(30, 50, 90, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.82);

  @media (max-width: $breakpoint-mobile) {
    padding: 22px 14px;
    border-radius: 24px;
  }
}

.install-glow {
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(circle at 82% 12%, rgba(68, 111, 174, 0.13), rgba(68, 111, 174, 0) 30%),
    radial-gradient(circle at 16% 20%, rgba(229, 185, 77, 0.16), rgba(229, 185, 77, 0) 28%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0));
  pointer-events: none;
}

.install-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 26px;

  @media (max-width: $breakpoint-mobile) {
    gap: 16px;
    margin-bottom: 22px;
  }
}

.install-copy {
  min-width: 0;
}

.install-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  width: fit-content;
  margin-bottom: 13px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  background: rgba(255, 255, 255, 0.62);
  color: rgba(30, 50, 90, 0.74);
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

.install-mark {
  flex: 0 0 auto;
  width: clamp(74px, 10vw, 118px);
  aspect-ratio: 1;
  border-radius: 28px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.42)),
    #f7f4ef;
  box-shadow:
    0 18px 45px rgba(30, 50, 90, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;

  img {
    width: 78%;
    height: 78%;
    object-fit: contain;
    display: block;
  }

  @media (max-width: $breakpoint-mobile) {
    width: 68px;
    border-radius: 20px;
  }
}

.panel-title {
  margin: 0;
  color: rgba(30, 38, 52, 0.92);
  font-size: clamp(32px, 4vw, 54px);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1;
}

.panel-desc {
  max-width: 610px;
  color: rgba(42, 50, 64, 0.68);
  font-size: 16px;
  line-height: 1.65;
  margin: 14px 0 0;
}

.install-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
  background: rgba(255, 255, 255, 0.48);
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 999px;
  padding: 5px;
  backdrop-filter: blur(14px);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  @media (max-width: $breakpoint-mobile) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-radius: 24px;
    overflow: visible;
  }
}

.tab-btn {
  flex: 1;
  min-height: 38px;
  padding: 8px 16px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: rgba(30, 50, 90, 0.62);
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
  transition: all $transition-fast;
  white-space: nowrap;

  @media (max-width: $breakpoint-mobile) {
    min-width: 0;
  }

  &.active {
    background: rgba(30, 50, 90, 0.9);
    color: #fff;
    box-shadow: 0 8px 22px rgba(30, 50, 90, 0.16);
  }
}

.install-content {
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.58);
  padding: 10px;
  backdrop-filter: blur(16px);

  @media (max-width: $breakpoint-mobile) {
    border-radius: 20px;
    padding: 8px;
  }
}

.download-list {
  display: grid;
  gap: 10px;
}

.download-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.62);
  color: rgba(30, 38, 52, 0.9);
  text-decoration: none;
  transition: transform $transition-fast, border-color $transition-fast, background $transition-fast;

  @media (max-width: $breakpoint-mobile) {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(30, 50, 90, 0.14);
    background: rgba(255, 255, 255, 0.8);
  }

  strong,
  small {
    display: block;
  }

  strong {
    font-size: 15px;
    font-weight: 650;
  }

  small {
    color: rgba(42, 50, 64, 0.58);
    font-size: 12px;
    margin-top: 3px;
  }
}

.download-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
    justify-content: stretch;
  }
}

.download-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  border: 1px solid rgba(30, 50, 90, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.64);
  padding: 7px 13px;
  color: rgba(30, 50, 90, 0.76);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: transform $transition-fast, border-color $transition-fast, background $transition-fast;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(30, 50, 90, 0.18);
    background: rgba(255, 255, 255, 0.9);
  }

  @media (max-width: $breakpoint-mobile) {
    flex: 1 1 0;
    min-width: 0;
    padding: 7px 10px;
    font-size: 12px;
    line-height: 1.2;
    text-align: center;
  }
}

.all-downloads {
  display: inline-flex;
  margin: 16px 6px 2px;
  color: rgba(30, 50, 90, 0.82);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.code-block {
  background: rgba(255, 255, 255, 0.66);
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 18px;
  padding: 14px 18px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: transform $transition-fast, border-color $transition-fast, background $transition-fast;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(30, 50, 90, 0.14);
    background: rgba(255, 255, 255, 0.84);
  }

  code {
    font-size: 14px;
    background: transparent;
    color: rgba(30, 50, 90, 0.84);
    padding: 0;
    white-space: nowrap;
  }
}

.prereq {
  color: rgba(42, 50, 64, 0.58);
  font-size: 13px;
  margin: 16px 6px 2px;
}
</style>
