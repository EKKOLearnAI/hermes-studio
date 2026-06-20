<script setup lang="ts">
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { getThemeOverrides } from '@client/styles/theme'
import SiteHeader from '@/components/layout/SiteHeader.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'
</script>

<template>
  <NConfigProvider :theme-overrides="getThemeOverrides(false)">
    <NMessageProvider>
      <div class="website-app">
        <SiteHeader />
        <main class="website-main">
          <router-view />
        </main>
        <SiteFooter />
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
.website-app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.website-main {
  flex: 1;
}
</style>
