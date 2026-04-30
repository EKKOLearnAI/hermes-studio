<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal, NButton, NSpace, NRadioGroup, NRadio, NCheckbox, NCode, useMessage } from 'naive-ui'
import { useChatStore, type ApprovalRequest } from '@/stores/hermes/chat'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const chatStore = useChatStore()
const message = useMessage()

const showModal = computed(() => chatStore.currentApproval !== null)
const approval = computed(() => chatStore.currentApproval as ApprovalRequest | null)
const loading = ref(false)
const choice = ref<'once' | 'session' | 'always'>('once')
const resolveAll = ref(false)

function handleApprove() {
  if (!approval.value) return
  loading.value = true
  chatStore.handleApprove(choice.value, resolveAll.value)
    .then(() => {
      // Success - approval will be auto-removed by the store
    })
    .catch(() => {
      message.error(t('chat.approvalFailed'))
    })
    .finally(() => {
      loading.value = false
      choice.value = 'once'
      resolveAll.value = false
    })
}

function handleDeny() {
  if (!approval.value) return
  loading.value = true
  chatStore.handleDeny(resolveAll.value)
    .then(() => {
      // Success - approval will be auto-removed by the store
    })
    .catch(() => {
      message.error(t('chat.denyFailed'))
    })
    .finally(() => {
      loading.value = false
      resolveAll.value = false
    })
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="approval?.title || t('chat.approvalRequired')"
    :style="{ width: 'min(560px, calc(100vw - 32px))' }"
    :mask-closable="false"
    :closable="false"
  >
    <div class="approval-content">
      <p class="approval-message">{{ approval?.message }}</p>
      
      <!-- Show the command that needs approval -->
      <div v-if="approval?.command" class="approval-command">
        <div class="command-label">{{ t('chat.approvalCommand') }}:</div>
        <NCode :code="approval.command" language="bash" />
      </div>
      
      <div class="approval-choices">
        <div class="choices-label">{{ t('chat.approvalScope') }}:</div>
        <NRadioGroup v-model:value="choice">
          <NSpace vertical>
            <NRadio value="once">{{ t('chat.approvalOnce') }}</NRadio>
            <NRadio value="session">{{ t('chat.approvalSession') }}</NRadio>
            <NRadio value="always">{{ t('chat.approvalAlways') }}</NRadio>
          </NSpace>
        </NRadioGroup>
      </div>
      
      <div class="approval-resolve-all">
        <NCheckbox v-model:checked="resolveAll">
          {{ t('chat.approvalResolveAll') }}
        </NCheckbox>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton type="error" :loading="loading" @click="handleDeny">
          {{ t('common.deny') }}
        </NButton>
        <NButton type="primary" :loading="loading" @click="handleApprove">
          {{ t('common.approve') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.approval-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.approval-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
}

.approval-command {
  background: var(--n-color);
  border-radius: 8px;
  padding: 12px;
  
  .command-label {
    font-size: 12px;
    color: var(--n-text-color-3);
    margin-bottom: 8px;
  }
}

.approval-choices {
  padding: 12px 0;
  
  .choices-label {
    font-size: 12px;
    color: var(--n-text-color-3);
    margin-bottom: 8px;
  }
}

.approval-resolve-all {
  padding-top: 8px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>