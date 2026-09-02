<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NEmpty } from 'naive-ui'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const agentNames: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
}

const sectionLabels = computed<Record<string, string>>(() => ({
  memory: t('sidebar.memory'),
  skills: t('sidebar.skills'),
  mcp: t('sidebar.mcp'),
  settings: t('sidebar.settings'),
}))

const agentId = computed(() => String(route.params.agentId || ''))
const section = computed(() => String(route.params.section || 'settings'))
const agentName = computed(() => agentNames[agentId.value] || agentId.value)
const sectionLabel = computed(() => sectionLabels.value[section.value] || t('sidebar.settings'))
</script>

<template>
  <div class="coding-agent-config-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ agentName }} · {{ sectionLabel }}</h2>
        <p class="header-description">{{ agentId }}</p>
      </div>
      <NButton size="small" secondary @click="router.push({ name: 'hermes.agentManager' })">
        {{ t('ekkoConfig.back') }}
      </NButton>
    </header>
    <div class="coding-agent-config-content">
      <NEmpty :description="sectionLabel" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.coding-agent-config-view {
  min-height: 100%;
  padding: 20px;
  background: $bg-main-surface;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.header-title {
  margin: 0;
  color: $text-primary;
  font-size: 20px;
}

.header-description {
  margin: 6px 0 0;
  color: $text-muted;
  font-size: 13px;
}

.coding-agent-config-content {
  display: grid;
  min-height: 320px;
  place-items: center;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: $bg-card;
}
</style>
