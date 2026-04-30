<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSwitch, NText, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const name = ref('')
const clone = ref(false)

async function handleSave() {
  if (!name.value.trim()) {
    message.warning(t('profiles.namePlaceholder'))
    return
  }

  loading.value = true
  try {
    const res = await profilesStore.createProfile(name.value.trim(), clone.value)
    if (res.success) {
      const stripped = res.strippedCredentials ?? []
      const disabled = res.disabledPlatforms ?? []
      const cfgStripped = res.strippedConfigCredentials ?? []
      if (clone.value && (stripped.length > 0 || disabled.length > 0 || cfgStripped.length > 0)) {
        const parts: string[] = []
        if (stripped.length > 0) parts.push(t('profiles.cloneStrippedCredentials', { count: stripped.length, list: stripped.join(', ') }))
        if (disabled.length > 0) parts.push(t('profiles.cloneDisabledPlatforms', { count: disabled.length, list: disabled.join(', ') }))
        if (cfgStripped.length > 0) parts.push(t('profiles.cloneStrippedConfigCredentials', { count: cfgStripped.length, list: cfgStripped.join(', ') }))
        message.info(`${t('profiles.createSuccess', { name: name.value.trim() })}\n${parts.join('\n')}`, { duration: 6000 })
      } else {
        message.success(t('profiles.createSuccess', { name: name.value.trim() }))
      }
      emit('saved')
    } else {
      message.error(t('profiles.createFailed'))
    }
  } finally {
    loading.value = false
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
    :title="t('profiles.create')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.name')" required>
        <NInput
          :value="name"
          :placeholder="t('profiles.namePlaceholder')"
          @input="name = $event.toLowerCase().replace(/[^a-z0-9_-]/g, '')"
          @keyup.enter="handleSave"
        />
      </NFormItem>

      <NFormItem :label="t('profiles.cloneFromCurrent')">
        <NSwitch v-model:value="clone" />
      </NFormItem>
      <NText v-if="clone" depth="3" style="font-size: 12px;">
        {{ t('profiles.cloneCleanupNotice') }}
      </NText>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.create') }}
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

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
