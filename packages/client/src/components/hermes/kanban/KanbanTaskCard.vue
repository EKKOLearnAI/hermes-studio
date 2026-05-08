<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { KanbanTask } from '@/api/hermes/kanban'

const props = defineProps<{
  task: KanbanTask
}>()

const emit = defineEmits<{
  click: [taskId: string]
}>()

const { t } = useI18n()

const timeAgo = computed(() => {
  const diff = Date.now() / 1000 - props.task.created_at
  if (diff < 60) return t('kanban.card.timeAgo.justNow')
  if (diff < 3600) return t('kanban.card.timeAgo.minutes', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('kanban.card.timeAgo.hours', { count: Math.floor(diff / 3600) })
  return t('kanban.card.timeAgo.days', { count: Math.floor(diff / 86400) })
})

const priorityLabel = computed(() => {
  if (props.task.priority >= 3) return 'high'
  if (props.task.priority === 2) return 'medium'
  return 'low'
})

const priorityText = computed(() => {
  return t(`kanban.card.priority.${priorityLabel.value}`)
})
</script>

<template>
  <div class="kanban-task-card" @click="emit('click', task.id)">
    <div class="card-title">{{ task.title }}</div>
    <div class="card-meta">
      <NTooltip v-if="task.assignee" trigger="hover">
        <template #trigger>
          <span class="meta-tag assignee-tag">{{ task.assignee }}</span>
        </template>
        {{ t('kanban.card.assigneeTooltip') }}
      </NTooltip>
      <span v-if="task.priority >= 2" class="meta-tag priority-tag" :class="priorityLabel">{{ priorityText }}</span>
      <span class="meta-time">{{ timeAgo }}</span>
    </div>
    <div v-if="task.body" class="card-body-preview">{{ task.body.slice(0, 80) }}{{ task.body.length > 80 ? '...' : '' }}</div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kanban-task-card {
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 12px;
  cursor: pointer;
  transition: border-color $transition-fast, box-shadow $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
  line-height: 1.4;
  word-break: break-word;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.meta-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.assignee-tag {
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
}

.priority-tag {
  &.high {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }

  &.medium {
    background: rgba(var(--warning-rgb), 0.12);
    color: $warning;
  }

  &.low {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }
}

.meta-time {
  font-size: 11px;
  color: $text-muted;
  margin-left: auto;
}

.card-body-preview {
  font-size: 12px;
  color: $text-muted;
  margin-top: 6px;
  line-height: 1.4;
}
</style>
