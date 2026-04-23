<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, useMessage } from 'naive-ui'
import { useModelsStore } from '@/stores/hermes/models'
import { useI18n } from 'vue-i18n'
import CodexLoginModal from './CodexLoginModal.vue'
import NousLoginModal from './NousLoginModal.vue'

const { t } = useI18n()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const modelsStore = useModelsStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const fetchingModels = ref(false)
const showCodexLogin = ref(false)
const showNousLogin = ref(false)

const providerType = ref<'preset' | 'custom'>('preset')
const selectedPreset = ref<string | null>(null)
const formData = ref({
  name: '',
  base_url: '',
  api_key: '',
  model: '',
})

const modelOptions = ref<Array<{ label: string; value: string }>>([])

const CODEX_KEY = 'openai-codex'
const NOUS_KEY = 'nous'

const isCodex = computed(() => selectedPreset.value === CODEX_KEY)
const isNous = computed(() => selectedPreset.value === NOUS_KEY)

const presetOptions = computed(() =>
  modelsStore.allProviders.map(g => ({ label: g.label, value: g.provider })),
)

function autoGenerateName(url: string): string {
  const clean = url.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '')
  const host = clean.split('/')[0]
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return t('models.local', { host })
  }
  return host.charAt(0).toUpperCase() + host.slice(1)
}

watch(selectedPreset, (val) => {
  formData.value.model = ''
  if (val) {
    const group = modelsStore.allProviders.find(g => g.provider === val)
    if (group) {
      formData.value.name = group.label
      formData.value.base_url = group.base_url
      modelOptions.value = group.models.map((m: string) => ({ label: m, value: m }))
      if (group.models.length > 0) {
        formData.value.model = group.models[0]
      }
    }
  }
})

watch(() => formData.value.base_url, (url) => {
  if (providerType.value === 'custom' && url.trim() && !formData.value.name) {
    formData.value.name = autoGenerateName(url.trim())
  }
})

watch(providerType, () => {
  modelOptions.value = []
  formData.value = { name: '', base_url: '', api_key: '', model: '' }
  selectedPreset.value = null
})

onMounted(() => {
  if (modelsStore.providers.length === 0) {
    modelsStore.fetchProviders()
  }
})

async function fetchModels() {
  const { base_url } = formData.value
  if (!base_url.trim()) {
    message.warning(t('models.enterBaseUrl'))
    return
  }

  fetchingModels.value = true
  try {
    const base = base_url.replace(/\/+$/, '')
    const url = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
    const headers: Record<string, string> = {}
    if (formData.value.api_key.trim()) {
      headers['Authorization'] = `Bearer ${formData.value.api_key.trim()}`
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) throw new Error(t('models.unexpectedFormat'))

    modelOptions.value = data.data.map(m => ({ label: m.id, value: m.id }))
    if (modelOptions.value.length > 0 && !formData.value.model) {
      formData.value.model = modelOptions.value[0].value
    }
    message.success(t('models.foundModels', { count: modelOptions.value.length }))
  } catch (e: any) {
    message.error(t('models.fetchFailed') + ': ' + e.message)
  } finally {
    fetchingModels.value = false
  }
}

async function handleSave() {
  if (providerType.value === 'preset' && !selectedPreset.value) {
    message.warning(t('models.selectProviderRequired'))
    return
  }

  // Codex: 弹出授权码弹窗
  if (isCodex.value) {
    showCodexLogin.value = true
    return
  }

  // Nous: 弹出 OAuth 设备码弹窗
  if (isNous.value) {
    showNousLogin.value = true
    return
  }

  if (!formData.value.base_url.trim()) {
    message.warning(t('models.baseUrlRequired'))
    return
  }
  if (!formData.value.api_key.trim()) {
    message.warning(t('models.apiKeyRequired'))
    return
  }
  if (!formData.value.model) {
    message.warning(t('models.modelRequired'))
    return
  }

  loading.value = true
  try {
    const providerKey = providerType.value === 'preset'
      ? selectedPreset.value
      : null

    await modelsStore.addProvider({
      name: formData.value.name.trim(),
      base_url: formData.value.base_url.trim(),
      api_key: formData.value.api_key.trim(),
      model: formData.value.model,
      providerKey,
    })
    message.success(t('models.providerAdded'))
    emit('saved')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

async function handleCodexSuccess() {
  showCodexLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleNousSuccess() {
  showNousLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
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
    :title="t('models.addProvider')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading && !showCodexLogin && !showNousLogin"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('models.providerType')">
        <div style="display: flex; gap: 12px">
          <NButton
            :type="providerType === 'preset' ? 'primary' : 'default'"
            size="small"
            @click="providerType = 'preset'"
          >
            {{ t('models.preset') }}
          </NButton>
          <NButton
            :type="providerType === 'custom' ? 'primary' : 'default'"
            size="small"
            @click="providerType = 'custom'"
          >
            {{ t('models.custom') }}
          </NButton>
        </div>
      </NFormItem>

      <NFormItem v-if="providerType === 'preset'" :label="t('models.selectProvider')" required>
        <NSelect
          v-model:value="selectedPreset"
          :options="presetOptions"
          :placeholder="t('models.chooseProvider')"
          filterable
        />
      </NFormItem>

      <NFormItem v-if="providerType === 'custom'" :label="t('models.name')">
        <NInput
          v-model:value="formData.name"
          :placeholder="t('models.autoGeneratedName')"
        />
      </NFormItem>

      <NFormItem v-if="!isCodex && !isNous" :label="t('models.baseUrl')" required>
        <NInput
          v-model:value="formData.base_url"
          :placeholder="t('models.baseUrlPlaceholder')"
          :disabled="providerType === 'preset'"
        />
      </NFormItem>

      <NFormItem v-if="!isCodex && !isNous" :label="t('models.apiKey')" required>
        <NInput
          v-model:value="formData.api_key"
          type="password"
          show-password-on="click"
          :placeholder="t('models.apiKeyPlaceholder')"
          autocomplete="off"
        />
      </NFormItem>

      <NFormItem :label="t('models.defaultModel')" required>
        <div style="display: flex; gap: 8px; width: 100%">
          <NSelect
            v-model:value="formData.model"
            :options="modelOptions"
            filterable
            tag
            :placeholder="t('models.selectOrInput')"
            style="flex: 1"
          />
          <NButton
            v-if="providerType === 'custom' || (providerType === 'preset' && modelOptions.length === 0)"
            :loading="fetchingModels"
            @click="fetchModels"
          >
            {{ t('common.fetch') }}
          </NButton>
        </div>
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.add') }}
        </NButton>
      </div>
    </template>

    <CodexLoginModal
      v-if="showCodexLogin"
      @close="showCodexLogin = false"
      @success="handleCodexSuccess"
    />

    <NousLoginModal
      v-if="showNousLogin"
      @close="showNousLogin = false"
      @success="handleNousSuccess"
    />
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
