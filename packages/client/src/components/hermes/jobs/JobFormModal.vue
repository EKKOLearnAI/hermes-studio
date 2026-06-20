<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NInputNumber, useMessage } from 'naive-ui'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useSettingsStore } from '@/stores/hermes/settings'
import {
  buildJobUpdateRequest,
  getJob,
  jobRepeatToEditValue,
  scheduleToEditableInput,
} from '@/api/hermes/jobs'
import type { CreateJobRequest, Job } from '@/api/hermes/jobs'
import { fetchSkills } from '@/api/hermes/skills'
import type { SkillInfo } from '@/api/hermes/skills'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  jobId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const jobsStore = useJobsStore()
const settingsStore = useSettingsStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const skillsLoading = ref(false)
const skillOptions = ref<Array<{ label: string; value: string }>>([])

const formData = ref({
  name: '',
  schedule: '',
  prompt: '',
  deliver: 'origin',
  skills: [] as string[],
  repeat_times: null as number | null,
})

const presetValue = ref<string | null>(null)

const isEdit = computed(() => !!props.jobId)

const schedulePresets = computed(() => [
  { label: t('jobs.presetEveryMinute'), value: '* * * * *' },
  { label: t('jobs.presetEvery5Min'), value: '*/5 * * * *' },
  { label: t('jobs.presetEveryHour'), value: '0 * * * *' },
  { label: t('jobs.presetEveryDay'), value: '0 0 * * *' },
  { label: t('jobs.presetEveryDay9'), value: '0 9 * * *' },
  { label: t('jobs.presetEveryMonday'), value: '0 9 * * 1' },
  { label: t('jobs.presetEveryMonth'), value: '0 9 1 * *' },
])

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isDeliverTargetConfigured(key: string): boolean {
  const config = settingsStore.platforms[key] || {}
  switch (key) {
    case 'telegram':
    case 'discord':
    case 'slack':
      return hasText(config.token)
    case 'whatsapp':
      return config.enabled === true || config.enabled === 'true'
    case 'matrix':
      return hasText(config.token) && hasText(config.extra?.homeserver)
    case 'weixin':
      return hasText(config.token) && hasText(config.extra?.account_id)
    case 'wecom':
      return hasText(config.extra?.bot_id) && hasText(config.extra?.secret)
    case 'feishu':
      return hasText(config.extra?.app_id) && hasText(config.extra?.app_secret)
    case 'dingtalk':
      return (hasText(config.extra?.client_id) && hasText(config.extra?.client_secret))
        || (hasText(config.extra?.app_key) && hasText(config.extra?.client_secret))
    case 'qqbot':
      return hasText(config.extra?.app_id) && hasText(config.extra?.client_secret)
    default:
      return false
  }
}

const targetOptions = computed(() => {
  const options: Array<{ label: string; value: string; disabled?: boolean }> = [
    { label: t('jobs.origin'), value: 'origin' },
    { label: t('jobs.local'), value: 'local' },
  ]
  const channels = [
    { key: 'telegram', label: 'Telegram' },
    { key: 'discord', label: 'Discord' },
    { key: 'slack', label: 'Slack' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'matrix', label: 'Matrix' },
    { key: 'weixin', label: 'WeChat' },
    { key: 'wecom', label: 'WeCom' },
    { key: 'feishu', label: 'Feishu' },
    { key: 'dingtalk', label: 'DingTalk' },
    { key: 'qqbot', label: 'QQBot' },
  ]
  for (const ch of channels) {
    options.push({
      label: ch.label,
      value: ch.key,
      disabled: !isDeliverTargetConfigured(ch.key),
    })
  }
  return options
})

const originalJob = ref<Job | null>(null)

function buildSkillOptions(skills: SkillInfo[]): Array<{ label: string; value: string }> {
  const byName = new Map<string, SkillInfo>()
  for (const skill of skills) {
    if (skill.enabled === false) continue
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
    .map(skill => ({ label: skill.name, value: skill.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

async function loadSkillOptions() {
  skillsLoading.value = true
  try {
    const data = await fetchSkills()
    skillOptions.value = buildSkillOptions(data.categories.flatMap(category => category.skills || []))
  } catch {
    skillOptions.value = []
  } finally {
    skillsLoading.value = false
  }
}

onMounted(async () => {
  if (Object.keys(settingsStore.platforms || {}).length === 0) {
    await settingsStore.fetchSettings()
  }
  await loadSkillOptions()

  if (props.jobId) {
    try {
      const job = await getJob(props.jobId)
      originalJob.value = job
      formData.value = {
        name: job.name,
        schedule: scheduleToEditableInput(job.schedule, job.schedule_display || ''),
        prompt: job.prompt,
        deliver: job.deliver || 'origin',
        skills: job.skills || (job.skill ? [job.skill] : []),
        repeat_times: jobRepeatToEditValue(job.repeat),
      }
    } catch (e: any) {
      message.error(t('jobs.loadFailed') + ': ' + e.message)
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
    if (isEdit.value) {
      if (!originalJob.value) {
        message.error(t('jobs.loadFailed'))
        return
      }
      const payload = buildJobUpdateRequest(originalJob.value, formData.value)
      if (Object.keys(payload).length === 0) {
        message.success(t('jobs.jobUpdated'))
        emit('saved')
        return
      }
      await jobsStore.updateJob(props.jobId!, payload)
      message.success(t('jobs.jobUpdated'))
    } else {
      const payload: CreateJobRequest = {
        name: formData.value.name,
        schedule: formData.value.schedule,
        prompt: formData.value.prompt,
        deliver: formData.value.deliver,
        skills: formData.value.skills,
        repeat: formData.value.repeat_times ?? undefined,
      }
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

      <NFormItem :label="t('jobs.skills')">
        <NSelect
          v-model:value="formData.skills"
          multiple
          filterable
          clearable
          :loading="skillsLoading"
          :options="skillOptions"
          :placeholder="t('jobs.skillsPlaceholder')"
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
