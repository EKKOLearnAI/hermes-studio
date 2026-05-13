<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { useScrollReveal } from '@/composables/useScrollReveal'

const { t } = useI18n()
useScrollReveal()
const activeTab = ref<'npm' | 'docker' | 'source'>('npm')

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
        v-for="tab in (['npm', 'docker', 'source'] as const)"
        :key="tab"
        class="tab-btn"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ t(`install.${tab}.title`) }}
      </button>
    </div>

    <div class="install-content reveal reveal-delay-1">
      <template v-if="activeTab === 'npm'">
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
      <p class="prereq">{{ t('install.prereq') }}</p>
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
