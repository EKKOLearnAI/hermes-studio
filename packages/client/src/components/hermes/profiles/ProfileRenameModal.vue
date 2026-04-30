<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ profileName: string }>()
const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const newName = ref('')

async function handleSave() {
  if (!newName.value.trim()) {
    message.warning(t('profiles.newNamePlaceholder'))
    return
  }

  loading.value = true
  try {
    const ok = await profilesStore.renameProfile(props.profileName, newName.value.trim())
    if (ok) {
      message.success(t('profiles.renameSuccess'))
      emit('saved')
    } else {
      message.error(t('profiles.renameFailed'))
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
    :title="t('profiles.rename')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.newName')" required>
        <NInput
          :value="newName"
          :placeholder="t('profiles.newNamePlaceholder')"
          @input="newName = $event.toLowerCase().replace(/[^a-z0-9_-]/g, '')"
          @keyup.enter="handleSave"
        />
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.confirm') }}
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
