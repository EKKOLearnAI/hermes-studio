<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { checkCopilotToken } from '@/api/hermes/copilot-auth'

const { t } = useI18n()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const showModal = ref(false)

async function loadProvidersForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  // 先 invalidate 后端 copilot 缓存（gh logout / VS Code 退出后下一次 list 立刻反映），
  // 再拉 providers 与 appStore 的模型显示名配置。check-token 失败不阻断。
  try { await checkCopilotToken() } catch { /* ignore */ }
  await modelsStore.fetchProviders()
}

onMounted(async () => {
  await loadProvidersForProfile()
})

function openCreateModal() {
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
}

async function handleSaved() {
  await modelsStore.fetchProviders()
  handleModalClose()
}

async function handleRefreshModelCache() {
  try {
    await modelsStore.refreshModelCache()
    message.success(t('models.refreshModelCacheSuccess'))
  } catch (e: any) {
    message.error(e?.message || t('models.refreshModelCacheFailed'))
  }
}
</script>

<template>
  <div class="models-view">
    <div v-if="modelsStore.refreshingModelCache" class="model-cache-overlay">
      <NSpin size="large" :description="t('models.refreshModelCacheLoading')" />
    </div>

    <header class="page-header">
      <h2 class="header-title">{{ t('models.title') }}</h2>
      <div class="header-actions">
        <NButton
          size="small"
          :loading="modelsStore.refreshingModelCache"
          :disabled="modelsStore.loading"
          @click="handleRefreshModelCache"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7"/><path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/></svg>
          </template>
          {{ t('models.refreshModelCache') }}
        </NButton>
        <NButton type="primary" size="small" @click="openCreateModal">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('models.addProvider') }}
        </NButton>
      </div>
    </header>

    <div class="models-content">
      <AuxiliaryModelsPanel />
      <NSpin :show="modelsStore.loading && modelsStore.providers.length === 0">
        <ProvidersPanel />
      </NSpin>
    </div>

    <ProviderFormModal
      v-if="showModal"
      @close="handleModalClose"
      @saved="handleSaved"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.models-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.model-cache-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, $bg-primary 78%, transparent);
  backdrop-filter: blur(2px);
}

.models-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
