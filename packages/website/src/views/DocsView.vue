<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import DocSidebar from '@/components/docs/DocSidebar.vue'
import DocContent from '@/components/docs/DocContent.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const pages = [
  { key: 'gettingStarted', name: 'docs.getting-started' },
  { key: 'configuration', name: 'docs.configuration' },
  { key: 'features', name: 'docs.features' },
  { key: 'platforms', name: 'docs.platforms' },
  { key: 'api', name: 'docs.api' },
]

function navigate(name: string) {
  router.push({ name })
}
</script>

<template>
  <div class="docs-layout">
    <DocSidebar v-if="route.meta.page" />
    <div class="docs-main">
      <nav v-if="route.meta.page" class="mobile-doc-tabs">
        <button
          v-for="p in pages"
          :key="p.key"
          class="mobile-tab"
          :class="{ active: route.name === p.name }"
          @click="navigate(p.name)"
        >
          {{ t(`docs.sidebar.${p.key}`) }}
        </button>
      </nav>
      <router-view />
      <DocContent v-if="route.meta.page" />
      <div v-else class="docs-placeholder">
        <p>Select a section from the sidebar to get started.</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.docs-layout {
  display: flex;
  max-width: 1120px;
  margin: 0 auto;
  min-height: calc(100vh - 60px - 200px);
}

.docs-main {
  flex: 1;
  min-width: 0;
}

.docs-placeholder {
  padding: 60px 32px;
  color: var(--text-muted);
  font-size: 16px;
  text-align: center;
}

// ─── Mobile doc tabs ────────────────────────────

.mobile-doc-tabs {
  display: none;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  gap: 4px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
  position: sticky;
  top: 60px;
  z-index: 10;

  &::-webkit-scrollbar {
    display: none;
  }
}

.mobile-tab {
  flex-shrink: 0;
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;
  white-space: nowrap;

  &.active {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
}

@media (max-width: $breakpoint-mobile) {
  .mobile-doc-tabs {
    display: flex;
  }
}
</style>
