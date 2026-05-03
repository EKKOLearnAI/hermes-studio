<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NModal, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  deleteCodexAccount,
  getCodexAuthStatus,
  pollCodexLogin,
  startCodexLogin,
  switchCodexAccount,
  type CodexAccount,
  type CodexStatusResult,
} from '@/api/hermes/codex-auth'

const emit = defineEmits<{
  refreshed: []
}>()

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const loading = ref(false)
const status = ref<CodexStatusResult>({ authenticated: false, accounts: [] })

const startLoading = ref(false)
const modalVisible = ref(false)
const loginCode = ref('')
const loginUrl = ref('')
const loginSessionId = ref('')
const pollError = ref('')
const pollState = ref<'pending' | 'approved' | 'expired' | 'error'>('pending')

const switchingId = ref('')
const deletingId = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null

const activeAccount = computed(() => status.value.accounts.find(a => a.active) || null)

function clearPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function refreshStatus() {
  loading.value = true
  try {
    status.value = await getCodexAuthStatus()
  } catch (err: any) {
    message.error(err?.message || t('models.codexLoadFailed'))
  } finally {
    loading.value = false
  }
}

async function checkPollOnce() {
  if (!loginSessionId.value) return
  try {
    const polled = await pollCodexLogin(loginSessionId.value)
    pollState.value = polled.status
    pollError.value = polled.error || ''

    if (polled.status === 'approved') {
      clearPollTimer()
      modalVisible.value = false
      message.success(t('models.codexApproved'))
      await refreshStatus()
      emit('refreshed')
      return
    }

    if (polled.status === 'expired') {
      clearPollTimer()
      pollError.value = t('models.codexExpired')
      return
    }

    if (polled.status === 'error') {
      clearPollTimer()
      if (!pollError.value) pollError.value = t('models.codexLoginFailed')
    }
  } catch (err: any) {
    clearPollTimer()
    pollError.value = err?.message || t('models.codexPollFailed')
  }
}

async function handleStartLogin() {
  startLoading.value = true
  pollError.value = ''
  try {
    const started = await startCodexLogin()
    loginSessionId.value = started.session_id
    loginCode.value = started.user_code
    loginUrl.value = started.open_url || started.verification_url
    pollState.value = 'pending'
    modalVisible.value = true

    clearPollTimer()
    pollTimer = setInterval(() => {
      void checkPollOnce()
    }, 3000)

    void checkPollOnce()
  } catch (err: any) {
    message.error(err?.message || t('models.codexLoginFailed'))
  } finally {
    startLoading.value = false
  }
}

async function handleSwitch(account: CodexAccount) {
  if (account.active) return
  switchingId.value = account.id
  try {
    await switchCodexAccount(account.id)
    message.success(t('models.codexSwitchSuccess'))
    await refreshStatus()
    emit('refreshed')
  } catch (err: any) {
    message.error(err?.message || t('models.codexSwitchFailed'))
  } finally {
    switchingId.value = ''
  }
}

function handleDelete(account: CodexAccount) {
  dialog.warning({
    title: t('models.codexDeleteTitle'),
    content: t('models.codexDeleteConfirm', { name: account.label }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      deletingId.value = account.id
      try {
        await deleteCodexAccount(account.id)
        message.success(t('models.codexDeleteSuccess'))
        await refreshStatus()
        emit('refreshed')
      } catch (err: any) {
        message.error(err?.message || t('models.codexDeleteFailed'))
      } finally {
        deletingId.value = ''
      }
    },
  })
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(loginCode.value)
    message.success(t('models.codexCopyCode'))
  } catch {
    message.error(t('common.saveFailed'))
  }
}

function closeModal() {
  modalVisible.value = false
}

onMounted(() => {
  void refreshStatus()
})

onBeforeUnmount(() => {
  clearPollTimer()
})
</script>

<template>
  <div class="codex-panel">
    <div class="codex-header">
      <div>
        <h3>{{ t('models.codexManageTitle') }}</h3>
        <p>{{ t('models.codexManageDesc') }}</p>
      </div>
      <div class="codex-actions">
        <NButton size="small" :loading="loading" @click="refreshStatus">{{ t('common.refresh') }}</NButton>
        <NButton type="primary" size="small" :loading="startLoading" @click="handleStartLogin">{{ t('models.codexAddAccount') }}</NButton>
      </div>
    </div>

    <div v-if="activeAccount" class="active-account">
      <span class="label">{{ t('models.codexActiveAccount') }}</span>
      <span class="value">{{ activeAccount.label }}</span>
    </div>

    <div v-if="status.accounts.length === 0" class="empty">{{ t('models.codexNoAccounts') }}</div>

    <div v-else class="accounts">
      <div v-for="account in status.accounts" :key="account.id" class="account-item">
        <div class="meta">
          <div class="top">
            <strong>{{ account.label }}</strong>
            <span v-if="account.active" class="active-badge">{{ t('models.codexActive') }}</span>
          </div>
          <div class="sub" v-if="account.email">{{ account.email }}</div>
        </div>
        <div class="ops">
          <NButton size="tiny" :disabled="account.active" :loading="switchingId === account.id" @click="handleSwitch(account)">
            {{ t('models.codexSwitch') }}
          </NButton>
          <NButton size="tiny" type="error" quaternary :loading="deletingId === account.id" @click="handleDelete(account)">
            {{ t('common.delete') }}
          </NButton>
        </div>
      </div>
    </div>

    <NModal v-model:show="modalVisible" preset="card" :title="t('models.codexLoginTitle')" style="max-width: 520px">
      <p class="modal-desc">{{ t('models.codexWaiting') }}</p>
      <div class="code-row">
        <NInput :value="loginCode" readonly />
        <NButton @click="copyCode">{{ t('common.copy') }}</NButton>
      </div>
      <div class="modal-actions">
        <a :href="loginUrl" target="_blank" rel="noopener">{{ t('models.codexOpenLink') }}</a>
      </div>
      <p class="poll-status" v-if="pollState === 'pending'">{{ t('common.loading') }}</p>
      <p class="poll-error" v-if="pollError">{{ pollError }}</p>
      <template #footer>
        <NButton @click="closeModal">{{ t('common.ok') }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.codex-panel {
  margin-bottom: 16px;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.45);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.codex-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 14px;
    color: $text-primary;
  }

  p {
    margin: 6px 0 0;
    font-size: 12px;
    color: $text-muted;
  }
}

.codex-actions {
  display: flex;
  gap: 8px;
}

.active-account {
  margin-top: 12px;
  font-size: 12px;

  .label {
    color: $text-muted;
    margin-right: 6px;
  }

  .value {
    color: $text-primary;
    font-weight: 500;
  }
}

.empty {
  margin-top: 12px;
  color: $text-muted;
  font-size: 12px;
}

.accounts {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.account-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.meta {
  min-width: 0;

  .top {
    display: flex;
    align-items: center;
    gap: 8px;

    strong {
      color: $text-primary;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 320px;
    }
  }

  .sub {
    color: $text-muted;
    font-size: 12px;
    margin-top: 2px;
  }
}

.active-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  color: $success;
  background: rgba(var(--success-rgb), 0.12);
}

.ops {
  display: flex;
  gap: 8px;
}

.modal-desc {
  margin: 0 0 10px;
  color: $text-secondary;
}

.code-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

.modal-actions {
  margin-top: 10px;

  a {
    color: $accent-primary;
    text-decoration: none;
  }
}

.poll-status {
  margin: 10px 0 0;
  color: $text-muted;
  font-size: 12px;
}

.poll-error {
  margin: 10px 0 0;
  color: $error;
  font-size: 12px;
}
</style>
