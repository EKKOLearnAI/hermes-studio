<script setup lang="ts">
import { useRoute } from 'vue-router'
import DocSidebar from '@/components/docs/DocSidebar.vue'
import DocContent from '@/components/docs/DocContent.vue'

const route = useRoute()
</script>

<template>
  <div class="docs-layout">
    <DocSidebar v-if="route.meta.page" />
    <div class="docs-main">
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
</style>
