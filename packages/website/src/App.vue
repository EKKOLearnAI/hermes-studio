<script setup lang="ts">
import { darkTheme } from 'naive-ui'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { useTheme } from '@/composables/useTheme'
import { getThemeOverrides } from '@client/styles/theme'
import SiteHeader from '@/components/layout/SiteHeader.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'

const { isDark } = useTheme()
</script>

<template>
  <NConfigProvider :theme="isDark ? darkTheme : undefined" :theme-overrides="getThemeOverrides(isDark)">
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
