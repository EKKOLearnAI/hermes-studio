<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSwitch, useMessage } from 'naive-ui'
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
    const ok = await profilesStore.createProfile(name.value.trim(), clone.value)
    if (ok) {
      message.success(t('profiles.createSuccess', { name: name.value.trim() }))
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
