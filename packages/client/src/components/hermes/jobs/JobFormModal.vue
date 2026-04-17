<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NInputNumber, useMessage } from 'naive-ui'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  jobId: string | null
  jobProfile: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const jobsStore = useJobsStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)

const formData = ref({
  name: '',
  schedule: '',
  prompt: '',
  deliver: 'origin',
  repeat_times: null as number | null,
  profile: '' as string,
})

const presetValue = ref<string | null>(null)

const isEdit = computed(() => !!props.jobId)

const profileOptions = computed(() => {
  const opts: { label: string; value: string }[] = []
  for (const p of jobsStore.profileJobs) {
    opts.push({
      label: p.profile === jobsStore.activeProfile ? `${p.profile} (${t('jobs.activeBot')})` : p.profile,
      value: p.profile,
    })
  }
  return opts
})

const schedulePresets = computed(() => [
  { label: t('jobs.presetEveryMinute'), value: '* * * * *' },
  { label: t('jobs.presetEvery5Min'), value: '*/5 * * * *' },
  { label: t('jobs.presetEveryHour'), value: '0 * * * *' },
  { label: t('jobs.presetEveryDay'), value: '0 0 * * *' },
  { label: t('jobs.presetEveryDay9'), value: '0 9 * * *' },
  { label: t('jobs.presetEveryMonday'), value: '0 9 * * 1' },
  { label: t('jobs.presetEveryMonth'), value: '0 9 1 * *' },
])

const targetOptions = computed(() => [
  { label: t('jobs.origin'), value: 'origin' },
  { label: t('jobs.local'), value: 'local' },
])

onMounted(async () => {
  // Default profile: use the currently selected/active profile
  formData.value.profile = props.jobProfile || jobsStore.selectedProfile || jobsStore.activeProfile || ''

  if (props.jobId) {
    // Read job from in-memory profileJobs data (works for all profiles, not just active)
    const found = jobsStore.findJobById(props.jobId)
    if (found) {
      const job = found.job
      formData.value = {
        name: job.name,
        schedule: typeof job.schedule === 'string' ? job.schedule : (job.schedule?.expr || job.schedule_display || ''),
        prompt: job.prompt,
        deliver: job.deliver || 'origin',
        repeat_times: typeof job.repeat === 'number' ? job.repeat : (typeof job.repeat === 'object' ? job.repeat.times : null),
        profile: props.jobProfile || found.profile || formData.value.profile,
      }
    } else {
      message.error(t('jobs.loadFailed'))
    }
  }
})

async function handleSave() {
  if (!formData.value.name.trim()) {
    message.warning(t('jobs.nameRequired'))
    return
  }
  if (!formData.value.schedule.trim()) {
    message.warning(t('jobs.scheduleRequired'))
    return
  }

  loading.value = true
  try {
    const payload = {
      name: formData.value.name,
      schedule: formData.value.schedule,
      prompt: formData.value.prompt,
      deliver: formData.value.deliver,
      repeat: formData.value.repeat_times ?? undefined,
    }

    if (isEdit.value) {
      await jobsStore.updateJob(props.jobId!, payload)
      message.success(t('jobs.jobUpdated'))
    } else if (formData.value.profile) {
      // Use profile-scoped CLI creation
      await jobsStore.createProfileJob(formData.value.profile, payload)
      message.success(t('jobs.jobCreated'))
    } else {
      // Fallback: use gateway API (active profile only)
      await jobsStore.createJob(payload)
      message.success(t('jobs.jobCreated'))
    }
    emit('saved')
  } catch (e: any) {
    message.error(e.message)
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
    :title="isEdit ? t('jobs.editJob') : t('jobs.createJob')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem v-if="!isEdit" :label="t('jobs.targetBot')">
        <NSelect
          v-model:value="formData.profile"
          :options="profileOptions"
          :placeholder="t('jobs.selectBot')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.name')" required>
        <NInput
          v-model:value="formData.name"
          :placeholder="t('jobs.namePlaceholder')"
          maxlength="200"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.schedule')" required>
        <NInput
          v-model:value="formData.schedule"
          :placeholder="t('jobs.schedulePlaceholder')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.quickPresets')">
        <NSelect
          v-model:value="presetValue"
          :options="schedulePresets"
          :placeholder="t('jobs.selectPreset')"
          @update:value="v => formData.schedule = v"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.prompt')" required>
        <NInput
          v-model:value="formData.prompt"
          type="textarea"
          :placeholder="t('jobs.promptPlaceholder')"
          :rows="4"
          maxlength="5000"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.deliverTarget')">
        <NSelect
          v-model:value="formData.deliver"
          :options="targetOptions"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.repeatCount')">
        <NInputNumber
          v-model:value="formData.repeat_times"
          :min="1"
          :placeholder="t('jobs.repeatPlaceholder')"
          clearable
          style="width: 100%"
        />
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ isEdit ? t('common.update') : t('common.create') }}
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
