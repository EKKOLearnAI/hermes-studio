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
    <h2 class="panel-title reveal">{{ t('install.title') }}</h2>
    <p class="panel-desc reveal">{{ t('install.desc') }}</p>

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
  padding: 40px 32px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-lg;

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

.install-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  background: var(--bg-secondary);
  border-radius: $radius-md;
  padding: 4px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.tab-btn {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;
  white-space: nowrap;

  &.active {
    background: var(--bg-card);
    color: var(--text-primary);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
}

.install-content {
  // full width within panel
}

.download-list {
  display: grid;
  gap: 8px;
}

.download-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  text-decoration: none;

  @media (max-width: $breakpoint-mobile) {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  &:first-child {
    padding-top: 0;
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
    color: var(--text-muted);
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
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  padding: 7px 12px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: border-color $transition-fast;

  &:hover {
    border-color: var(--text-muted);
  }

  @media (max-width: $breakpoint-mobile) {
    flex: 1 1 0;
  }
}

.all-downloads {
  display: inline-flex;
  margin-top: 14px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.code-block {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  padding: 14px 18px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color $transition-fast;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;

  &:hover {
    border-color: var(--text-muted);
  }

  code {
    font-size: 14px;
    background: transparent;
    padding: 0;
    white-space: nowrap;
  }
}

.prereq {
  color: var(--text-muted);
  font-size: 13px;
  margin-top: 16px;
}
</style>
