<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const pages = [
  { key: 'gettingStarted', name: 'docs.getting-started' },
  { key: 'configuration', name: 'docs.configuration' },
  { key: 'features', name: 'docs.features' },
  { key: 'platforms', name: 'docs.platforms' },
  { key: 'api', name: 'docs.api' },
]

function isActive(name: string) {
  return route.name === name
}

function navigate(name: string) {
  router.push({ name })
}
</script>

<template>
  <aside class="doc-sidebar">
    <nav class="sidebar-nav">
      <a
        v-for="p in pages"
        :key="p.key"
        class="sidebar-link"
        :class="{ active: isActive(p.name) }"
        @click.prevent="navigate(p.name)"
      >
        {{ t(`docs.sidebar.${p.key}`) }}
      </a>
    </nav>
  </aside>
</template>

<style scoped lang="scss">
.doc-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  padding: 24px 0;
  position: sticky;
  top: 60px;
  height: calc(100vh - 60px);
  overflow-y: auto;

  @media (max-width: $breakpoint-mobile) {
    display: none;
  }
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 12px;
}

.sidebar-link {
  display: block;
  padding: 8px 12px;
  border-radius: $radius-sm;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  &.active {
    color: var(--text-primary);
    background: var(--bg-secondary);
    font-weight: 500;
  }
}
</style>
