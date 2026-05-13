<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NSelect, NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useKanbanStore } from '@/stores/hermes/kanban'

const emit = defineEmits<{
  close: []
  created: []
}>()

const { t } = useI18n()
const message = useMessage()
const kanbanStore = useKanbanStore()

const title = ref('')
const body = ref('')
const assignee = ref<string | null>(null)
const priority = ref<number | null>(null)
const saving = ref(false)

const priorityOptions = computed(() => [
  { label: t('kanban.card.priority.low'), value: 1 },
  { label: t('kanban.card.priority.medium'), value: 2 },
  { label: t('kanban.card.priority.high'), value: 3 },
])

const assigneeOptions = computed(() => {
  return kanbanStore.assignees.map(a => {
    const total = Object.values(a.counts || {}).reduce((s, c) => s + c, 0)
    return { label: `${a.name} · ${t('kanban.stats.tasks')}: ${total}`, value: a.name }
  })
})

async function handleSubmit() {
  if (!title.value.trim()) {
    message.warning(t('kanban.form.titleRequired'))
    return
  }
  saving.value = true
  try {
    await kanbanStore.createTask({
      title: title.value.trim(),
      body: body.value.trim() || undefined,
      assignee: assignee.value || undefined,
      priority: priority.value ?? undefined,
    })
    message.success(t('kanban.message.taskCreated'))
    emit('created')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal :show="true" preset="dialog" :title="t('kanban.createTask')" style="width: 480px;" @close="emit('close')">
    <NForm label-placement="top">
      <NFormItem :label="t('kanban.form.title')">
        <NInput v-model:value="title" :placeholder="t('kanban.form.titlePlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.body')">
        <NInput v-model:value="body" type="textarea" :rows="3" :placeholder="t('kanban.form.bodyPlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.assignee')">
        <NSelect v-model:value="assignee" :options="assigneeOptions" :placeholder="t('kanban.form.selectAssignee')" clearable />
      </NFormItem>
      <NFormItem :label="t('kanban.form.priority')">
        <NSelect v-model:value="priority" :options="priorityOptions" :placeholder="t('kanban.form.selectPriority')" clearable />
      </NFormItem>
    </NForm>
    <template #action>
      <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
      <NButton type="primary" :loading="saving" @click="handleSubmit">{{ t('common.create') }}</NButton>
    </template>
  </NModal>
</template>
