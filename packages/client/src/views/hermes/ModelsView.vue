<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { checkCopilotToken } from '@/api/hermes/copilot-auth'

const { t } = useI18n()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const showModal = ref(false)

onMounted(async () => {
  // 先 invalidate 后端 copilot 缓存（gh logout / VS Code 退出后下一次 list 立刻反映），
  // 再拉 providers。check-token 失败不阻断。
  try { await checkCopilotToken() } catch { /* ignore */ }
  modelsStore.fetchProviders()
})

function openCreateModal() {
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
}

async function handleSaved() {
  await modelsStore.fetchProviders()
  appStore.loadModels()
  handleModalClose()
}
</script>

<template>
  <div class="models-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('models.title') }}</h2>
      <NButton type="primary" size="small" @click="openCreateModal">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </template>
        {{ t('models.addProvider') }}
      </NButton>
    </header>

    <div class="models-content">
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


.models-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
