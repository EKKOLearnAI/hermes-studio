<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()
const modelsStore = useModelsStore()
const appStore = useAppStore()

const showModal = ref(true)
const checking = ref(false)
const COMMAND = 'gh auth login --web'

async function copyCommand() {
  const ok = await copyToClipboard(COMMAND)
  if (ok) message.success(t('models.copilotCopied'))
  else message.error(t('models.copilotCopied') + ' ✗')
}

async function refreshDetect() {
  checking.value = true
  try {
    await Promise.all([modelsStore.fetchProviders(), appStore.loadModels()])
    // 已授权 providers（modelsStore.providers，对应后端 /available-models 的 groups）
    // 才是事实来源；allProviders 是 PRESETS 全量，Copilot 一直在里面，不能用作判定。
    const found = modelsStore.providers.some(g => g.provider === 'copilot')
    if (found) {
      message.success(t('models.copilotDetected'))
      emit('success')
    } else {
      message.warning(t('models.copilotNotDetected'))
    }
  } catch (e: any) {
    message.error(e?.message || t('models.copilotNotDetected'))
  } finally {
    checking.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.copilotLoginTitle')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!checking"
    @after-leave="emit('close')"
  >
    <div class="copilot-login">
      <p class="hint">{{ t('models.copilotLoginIntro') }}</p>

      <ol class="steps">
        <li>{{ t('models.copilotStep1') }}</li>
        <li>
          {{ t('models.copilotStep2') }}
          <div class="cmd-row">
            <code class="cmd">{{ COMMAND }}</code>
            <NButton size="small" @click="copyCommand">{{ t('common.copy') }}</NButton>
          </div>
        </li>
        <li>{{ t('models.copilotStep3') }}</li>
      </ol>

      <p class="note">{{ t('models.copilotLoginNote') }}</p>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="checking" @click="refreshDetect">
          {{ t('models.copilotRefresh') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.copilot-login {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hint {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}

.steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.cmd {
  flex: 1;
  padding: 6px 10px;
  background: var(--code-block-bg, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  user-select: all;
}

.note {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
