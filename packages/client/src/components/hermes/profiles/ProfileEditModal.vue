<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NModal, NForm, NFormItem, NSelect, NButton, NSpin, useMessage } from 'naive-ui'
import type { HermesProfile } from '@/api/hermes/profiles'
import { fetchAvailableModelsForProfile, type AvailableModelGroup } from '@/api/hermes/system'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ profile: HermesProfile }>()
const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const optionsLoading = ref(false)
const modelGroups = ref<AvailableModelGroup[]>([])
const selectedModelKey = ref('')
const currentProvider = ref('')
const currentModel = ref(props.profile.model === '—' ? '' : props.profile.model)

const modelOptions = computed(() => {
  return modelGroups.value.flatMap(group =>
    group.models.map(model => ({
      label: group.label && group.label !== group.provider ? `${group.label} / ${model}` : `${group.provider} / ${model}`,
      value: JSON.stringify({ provider: group.provider, model }),
    })),
  )
})

async function loadModelOptions() {
  optionsLoading.value = true
  try {
    const detail = await profilesStore.fetchProfileDetail(props.profile.name)
    currentProvider.value = detail?.provider || ''
    currentModel.value = detail?.model && detail.model !== '—' ? detail.model : currentModel.value
    const available = await fetchAvailableModelsForProfile(props.profile.name)
    modelGroups.value = available.groups || []
    selectedModelKey.value = findSelectionKey(currentProvider.value, currentModel.value)
  } catch (err: any) {
    message.error(err?.message || t('models.loadFailed'))
  } finally {
    optionsLoading.value = false
  }
}

function findSelectionKey(provider: string, model: string): string {
  const selected = modelGroups.value.find(group => group.provider === provider && group.models.includes(model))
    || modelGroups.value.find(group => group.models.includes(model))
  if (!selected || !model) return ''
  return JSON.stringify({ provider: selected.provider, model })
}

async function handleSave() {
  if (!selectedModelKey.value) {
    message.warning(t('profiles.modelRequired'))
    return
  }

  let parsed: { provider?: string; model?: string }
  try {
    parsed = JSON.parse(selectedModelKey.value)
  } catch {
    message.error(t('profiles.modelRequired'))
    return
  }

  if (!parsed.model) {
    message.warning(t('profiles.modelRequired'))
    return
  }

  loading.value = true
  try {
    const ok = await profilesStore.updateProfileModel(props.profile.name, parsed.model, parsed.provider)
    if (ok) {
      message.success(t('common.saved'))
      emit('saved')
    } else {
      message.error(t('common.saveFailed'))
    }
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}

onMounted(() => {
  void loadModelOptions()
})
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('common.edit')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading && !optionsLoading"
    @after-leave="emit('close')"
  >
    <NSpin :show="optionsLoading">
      <NForm label-placement="top">
        <NFormItem :label="t('profiles.model')" required>
          <NSelect
            v-model:value="selectedModelKey"
            :options="modelOptions"
            :placeholder="t('models.selectModel')"
            filterable
            clearable
          />
        </NFormItem>
      </NForm>
    </NSpin>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="loading || optionsLoading" @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="optionsLoading || modelOptions.length === 0" @click="handleSave">
          {{ t('common.save') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
