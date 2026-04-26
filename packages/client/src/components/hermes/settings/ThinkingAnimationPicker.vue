<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NAlert, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const hasCustom = ref(false)
const customType = ref('')
const loading = ref(false)
const uploading = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()

function getToken(): string {
  const profilesKey = localStorage.getItem('hermes_profiles_key')
  const api = localStorage.getItem('hermes_api_key')
  return (profilesKey || api || '').replace(/"/g, '')
}

async function fetchStatus() {
  loading.value = true
  try {
    const res = await fetch('/api/hermes/thinking-animation/status', {
      headers: { Authorization: `Bearer ${getToken()}` }
    })
    if (res.ok) {
      const data = await res.json()
      hasCustom.value = data.hasCustom
      customType.value = data.type || ''
    }
  } catch (e) {
    console.error('Failed to fetch animation status', e)
  } finally {
    loading.value = false
  }
}

function openPicker() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 100 * 1024 * 1024) {
    error.value = t('display.taFileTooLarge')
    return
  }
  uploading.value = true
  error.value = ''
  try {
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch('/api/hermes/thinking-animation', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `${t('display.taUploadFailed')} (${res.status})`)
    }
    await fetchStatus()
  } catch (e: any) {
    error.value = e.message || t('display.taUploadFailed')
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function resetAnimation() {
  try {
    await fetch('/api/hermes/thinking-animation', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` }
    })
    await fetchStatus()
  } catch (e: any) {
    error.value = e.message || t('display.taResetFailed')
  }
}

onMounted(fetchStatus)
</script>

<template>
  <div class="thinking-animation-picker">
    <div v-if="loading" style="text-align:center;padding:12px">
      <NSpin size="small" />
    </div>
    <template v-else>
      <div class="ta-row">
        <span class="ta-status">
          {{ hasCustom ? `${t('display.taCustomLoaded')} (${customType.toUpperCase()})` : t('display.taDefault') }}
        </span>
        <NButton size="small" @click="openPicker" :loading="uploading">
          {{ hasCustom ? t('display.taChange') : t('display.taUpload') }}
        </NButton>
        <NButton v-if="hasCustom" size="small" @click="resetAnimation" :loading="uploading">
          {{ t('display.taResetDefault') }}
        </NButton>
      </div>
      <div class="ta-help">
        {{ t('display.taHelp') }}
      </div>
      <NAlert v-if="error" type="error" style="margin-top:8px" closable @close="error=''">
        {{ error }}
      </NAlert>
      <input ref="fileInput" type="file" accept="video/*,image/gif" style="display:none" @change="onFileChange" />
    </template>
  </div>
</template>

<style scoped lang="scss">
.thinking-animation-picker {
  padding: 4px 0;
}
.ta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ta-status {
  font-size: 13px;
  color: var(--text-secondary, #aaa);
}
.ta-help {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted, #888);
  line-height: 1.5;
  padding: 8px 12px;
  background: var(--bg-tertiary, #1a1a2e);
  border-radius: 6px;
}
</style>
