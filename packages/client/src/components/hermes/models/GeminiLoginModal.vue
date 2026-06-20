<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { NModal, NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { startGeminiLogin, pollGeminiLogin } from '@/api/hermes/gemini-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | 'waiting' | 'approved' | 'expired' | 'error'>('idle')
const authorizationUrl = ref('')
const sessionId = ref('')
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

async function startLogin() {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    const data = await startGeminiLogin()
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    window.open(authorizationUrl.value, '_blank')
    startPolling()
  } catch (err: any) {
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    message.error(errorMessage.value)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setTimeout(async () => {
    try {
      const result = await pollGeminiLogin(sessionId.value)
      if (result.status === 'pending') {
        startPolling()
      } else if (result.status === 'approved') {
        status.value = 'approved'
        message.success(t('models.geminiApproved'))
        setTimeout(() => {
          showModal.value = false
          setTimeout(() => emit('success'), 200)
        }, 1000)
      } else if (result.status === 'expired') {
        status.value = 'expired'
      } else if (result.status === 'error') {
        status.value = 'error'
        errorMessage.value = result.error || 'Unknown error'
      }
    } catch {
      startPolling()
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function handleClose() {
  stopPolling()
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}

function openLink() {
  window.open(authorizationUrl.value, '_blank')
}

async function copyLink() {
  const ok = await copyToClipboard(authorizationUrl.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

function retry() {
  authorizationUrl.value = ''
  sessionId.value = ''
  errorMessage.value = ''
  startLogin()
}

onUnmounted(stopPolling)
startLogin()
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.geminiLoginTitle')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="status !== 'waiting'"
    @after-leave="emit('close')"
  >
    <div class="oauth-login">
      <div v-if="status === 'idle' || status === 'loading'" class="oauth-login__state">
        <NSpin size="small" />
      </div>

      <div v-else-if="status === 'waiting'" class="oauth-login__state">
        <p class="oauth-login__hint">{{ t('models.geminiWaiting') }}</p>
        <NButton type="primary" block @click="openLink">
          {{ t('models.geminiOpenLink') }}
        </NButton>
        <NButton block @click="copyLink">
          {{ t('models.geminiCopyLink') }}
        </NButton>
      </div>

      <div v-else-if="status === 'approved'" class="oauth-login__state oauth-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.geminiApproved') }}</p>
      </div>

      <div v-else-if="status === 'expired'" class="oauth-login__state">
        <p class="oauth-login__error">{{ t('models.geminiExpired') }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>

      <div v-else-if="status === 'error'" class="oauth-login__state">
        <p class="oauth-login__error">{{ errorMessage }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="status === 'waiting'" @click="handleClose">{{ t('common.cancel') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.oauth-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
}

.oauth-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-height: 120px;
  justify-content: center;
  width: 100%;
}

.oauth-login__hint {
  font-size: 14px;
  color: var(--n-text-color, inherit);
  text-align: center;
  line-height: 1.6;
}

.oauth-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.oauth-login__error {
  color: #d03050;
  text-align: center;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
