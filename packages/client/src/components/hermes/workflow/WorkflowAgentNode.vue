<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import { NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { WorkflowAgentNodeData, WorkflowAgentNodeEditableData } from './types'

import '@vue-flow/node-resizer/dist/style.css'

const props = defineProps<NodeProps<WorkflowAgentNodeData>>()
const { t } = useI18n()

const statusClass = computed(() => `status-${props.data.status}`)

function updateField<K extends keyof WorkflowAgentNodeEditableData>(key: K, value: WorkflowAgentNodeEditableData[K]) {
  props.data.onUpdate(props.id, { [key]: value } as Partial<WorkflowAgentNodeEditableData>)
}
</script>

<template>
  <div class="workflow-agent-node" :class="[statusClass, { selected }]">
    <NodeResizer
      :is-visible="selected"
      :min-width="260"
      :min-height="240"
      color="var(--accent-info)"
      handle-class-name="workflow-resize-handle"
      line-class-name="workflow-resize-line"
    />
    <Handle id="input" type="target" :position="Position.Left" class="workflow-handle input-handle" />

    <div class="node-header">
      <span class="node-status-dot" />
      <span class="node-title">{{ data.title }}</span>
    </div>

    <div class="node-controls nodrag nopan" @pointerdown.stop @mousedown.stop @touchstart.stop>
      <NSelect
        :value="data.agent"
        :options="data.agentOptions"
        size="small"
        :placeholder="t('workflow.node.agent')"
        @update:value="value => updateField('agent', value as string)"
      />
      <NSelect
        :value="data.model"
        :options="data.modelOptions"
        size="small"
        filterable
        :placeholder="t('workflow.node.model')"
        @update:value="value => updateField('model', value as string)"
      />
      <NInput
        class="node-prompt-input"
        :value="data.prompt"
        type="textarea"
        size="small"
        :resizable="false"
        :input-props="{ style: { height: '100%', resize: 'none' } }"
        :placeholder="t('workflow.node.promptPlaceholder')"
        @update:value="value => updateField('prompt', value)"
      />
    </div>

    <Handle id="output" type="source" :position="Position.Right" class="workflow-handle output-handle" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-agent-node {
  width: 100%;
  height: 100%;
  min-width: 260px;
  min-height: 240px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-card;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  color: $text-primary;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &.selected {
    border-color: var(--accent-info);
    box-shadow: 0 0 0 3px rgba(var(--accent-info-rgb), 0.16), 0 12px 28px rgba(0, 0, 0, 0.12);
  }
}

.workflow-agent-node :deep(.workflow-resize-handle) {
  width: 10px;
  height: 10px;
  border: 2px solid $bg-card;
  background: var(--accent-info);
}

.workflow-agent-node :deep(.workflow-resize-line) {
  border-color: var(--accent-info);
}

.node-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid $border-light;
  font-size: 13px;
  font-weight: 600;
  flex: 0 0 auto;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
}

.node-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: $text-muted;
}

.status-ready .node-status-dot {
  background: var(--success);
}

.status-running .node-status-dot {
  background: var(--accent-info);
  box-shadow: 0 0 8px rgba(var(--accent-info-rgb), 0.65);
}

.node-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  flex: 1;
  min-height: 0;
}

.node-prompt-input {
  flex: 1;
  min-height: 84px;

  :deep(.n-input-wrapper),
  :deep(.n-input__textarea) {
    height: 100%;
    resize: none !important;
  }

  :deep(.n-input__textarea-el) {
    height: 100% !important;
    min-height: 84px;
    resize: none !important;

    &::-webkit-resizer {
      display: none;
    }
  }
}

.workflow-handle {
  width: 12px;
  height: 12px;
  border: 2px solid $bg-card;
  background: var(--accent-info);
}

.input-handle {
  left: -7px;
}

.output-handle {
  right: -7px;
}
</style>
