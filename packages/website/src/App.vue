<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { getThemeOverrides } from '@client/styles/theme'
import SiteHeader from '@/components/layout/SiteHeader.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'

const route = useRoute()
const isLanding = computed(() => route.name === 'landing')
const showChrome = computed(() => !isLanding.value)
const pageTitle = computed(() => {
  if (typeof route.meta.title === 'string' && route.meta.title.trim()) {
    return route.meta.title
  }

  return 'Paulo Cavallari Tech'
})

watchEffect(() => {
  document.title = pageTitle.value
})
</script>

<template>
  <NConfigProvider :theme-overrides="getThemeOverrides(false)">
    <NMessageProvider>
      <div class="website-app" :class="{ 'website-app--landing': isLanding }">
        <SiteHeader v-if="showChrome" />
        <main class="website-main">
          <router-view />
        </main>
        <SiteFooter v-if="showChrome" />
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

.website-app--landing {
  background: transparent;
}

.website-main {
  flex: 1;
}
</style>
