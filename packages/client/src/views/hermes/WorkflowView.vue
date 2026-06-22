<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NDropdown, type DropdownOption } from 'naive-ui'
import {
  ConnectionLineType,
  MarkerType,
  VueFlow,
  useVueFlow,
  type Connection,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { useI18n } from 'vue-i18n'
import WorkflowAgentNode from '@/components/hermes/workflow/WorkflowAgentNode.vue'
import { useAppStore } from '@/stores/hermes/app'
import type {
  WorkflowAgentNodeData,
  WorkflowAgentNodeEditableData,
  WorkflowNodeStatus,
  WorkflowSelectOption,
} from '@/components/hermes/workflow/types'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const { t } = useI18n()
const appStore = useAppStore()
const { fitView } = useVueFlow('hermes-workflow')

interface WorkflowNode {
  id: string
  type: 'agent'
  position: { x: number; y: number }
  dragHandle: string
  style: { width: string; height: string }
  data: WorkflowAgentNodeData
}

interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  type: 'smoothstep'
  animated?: boolean
  markerEnd?: MarkerType
}

const nextNodeIndex = ref(4)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuOpenedAt = ref(0)
const contextMenuTarget = ref<{ type: 'node' | 'edge'; id: string } | null>(null)

const agentOptions = computed<WorkflowSelectOption[]>(() => [
  { label: 'hermes', value: 'hermes' },
  { label: 'claude', value: 'claude' },
  { label: 'codex', value: 'codex' },
])

const fallbackModelOptions = computed<WorkflowSelectOption[]>(() => [
  { label: t('workflow.models.default'), value: 'default' },
  { label: t('workflow.models.fast'), value: 'fast' },
  { label: t('workflow.models.reasoning'), value: 'reasoning' },
])

const modelOptions = computed<WorkflowSelectOption[]>(() => {
  const loaded = appStore.modelGroups.flatMap(group =>
    group.models.map(model => ({
      label: `${group.label} / ${appStore.displayModelName(model, group.provider)}`,
      value: `${group.provider}:${model}`,
    })),
  )

  if (loaded.length === 0) return fallbackModelOptions.value
  return loaded
})

const defaultModelValue = computed(() => {
  if (appStore.selectedProvider && appStore.selectedModel) {
    return `${appStore.selectedProvider}:${appStore.selectedModel}`
  }
  return modelOptions.value[0]?.value || 'default'
})

const contextMenuOptions = computed<DropdownOption[]>(() => {
  if (contextMenuTarget.value?.type === 'edge') {
    return [{ key: 'delete-edge', label: t('workflow.actions.deleteEdge') }]
  }
  return [{ key: 'delete-node', label: t('workflow.actions.deleteNode') }]
})

function makeNode(
  id: string,
  title: string,
  position: { x: number; y: number },
  data: Partial<WorkflowAgentNodeEditableData> & { status?: WorkflowNodeStatus } = {},
): WorkflowNode {
  return {
    id,
    type: 'agent',
    position,
    dragHandle: '.node-header',
    style: { width: '260px', height: '240px' },
    data: {
      title,
      agent: data.agent || agentOptions.value[0]?.value || 'hermes',
      model: data.model || defaultModelValue.value,
      prompt: data.prompt || '',
      status: data.status || 'idle',
      agentOptions: agentOptions.value,
      modelOptions: modelOptions.value,
      onUpdate: updateNodeData,
    },
  }
}

function makeInitialNodes(): WorkflowNode[] {
  return [
    makeNode('agent-1', t('workflow.initialNodes.node1'), { x: 40, y: 120 }, {
      agent: 'hermes',
      status: 'ready',
      prompt: t('workflow.initialPrompts.node1'),
    }),
    makeNode('agent-2', t('workflow.initialNodes.node2'), { x: 390, y: 120 }, {
      agent: 'claude',
      status: 'running',
      prompt: t('workflow.initialPrompts.node2'),
    }),
    makeNode('agent-3', t('workflow.initialNodes.node3'), { x: 740, y: 120 }, {
      agent: 'codex',
      status: 'idle',
      prompt: t('workflow.initialPrompts.node3'),
    }),
  ]
}

const nodes = ref<WorkflowNode[]>(makeInitialNodes())
const edges = ref<WorkflowEdge[]>([
  {
    id: 'agent-1-agent-2',
    source: 'agent-1',
    target: 'agent-2',
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'smoothstep',
    animated: true,
    markerEnd: MarkerType.ArrowClosed,
  },
  {
    id: 'agent-2-agent-3',
    source: 'agent-2',
    target: 'agent-3',
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'smoothstep',
    markerEnd: MarkerType.ArrowClosed,
  },
])

watch([agentOptions, modelOptions], () => {
  nodes.value = nodes.value.map<WorkflowNode>(node => ({
    ...node,
    data: {
      ...node.data,
      agentOptions: agentOptions.value,
      modelOptions: modelOptions.value,
      model: modelOptions.value.some(option => option.value === node.data.model)
        ? node.data.model
        : defaultModelValue.value,
      onUpdate: updateNodeData,
    },
  }))
})

function updateNodeData(id: string, patch: Partial<WorkflowAgentNodeEditableData>) {
  nodes.value = nodes.value.map<WorkflowNode>(node => (
    node.id === id
      ? { ...node, data: { ...node.data, ...patch } }
      : node
  ))
}

function handleConnect(connection: Connection) {
  if (!connection.source || !connection.target || connection.source === connection.target) return
  const exists = edges.value.some(edge => edge.source === connection.source && edge.target === connection.target)
  if (exists) return

  edges.value = [...edges.value, {
    ...connection,
    id: `${connection.source}-${connection.target}`,
    type: 'smoothstep',
    animated: true,
    markerEnd: MarkerType.ArrowClosed,
  }]
}

function deleteNode(nodeId: string) {
  nodes.value = nodes.value.filter(node => node.id !== nodeId)
  edges.value = edges.value.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
}

function deleteEdge(edgeId: string) {
  edges.value = edges.value.filter(edge => edge.id !== edgeId)
}

function openContextMenu(event: MouseEvent | TouchEvent, target: { type: 'node' | 'edge'; id: string }) {
  event.preventDefault()
  event.stopPropagation()
  const touch = 'changedTouches' in event ? event.changedTouches[0] : null
  contextMenuX.value = touch?.clientX ?? ('clientX' in event ? event.clientX : 0)
  contextMenuY.value = touch?.clientY ?? ('clientY' in event ? event.clientY : 0)
  contextMenuOpenedAt.value = Date.now()
  contextMenuTarget.value = target
  contextMenuVisible.value = false
  void nextTick(() => {
    contextMenuVisible.value = true
  })
}

function handleNodeContextMenu(payload: { event: MouseEvent | TouchEvent; node: { id: string } }) {
  openContextMenu(payload.event, { type: 'node', id: payload.node.id })
}

function handleEdgeContextMenu(payload: { event: MouseEvent | TouchEvent; edge: { id: string } }) {
  openContextMenu(payload.event, { type: 'edge', id: payload.edge.id })
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuTarget.value = null
}

function handleContextMenuClickOutside() {
  if (Date.now() - contextMenuOpenedAt.value < 180) return
  closeContextMenu()
}

function handleContextMenuSelect(key: string | number) {
  const target = contextMenuTarget.value
  if (key === 'delete-node' && target?.type === 'node') {
    deleteNode(target.id)
  }
  if (key === 'delete-edge' && target?.type === 'edge') {
    deleteEdge(target.id)
  }
  closeContextMenu()
}

async function addAgentNode() {
  const id = `agent-${nextNodeIndex.value}`
  const column = nextNodeIndex.value - 1
  nodes.value = [
    ...nodes.value,
    makeNode(id, t('workflow.newNodeTitle', { count: nextNodeIndex.value }), {
      x: 80 + (column % 3) * 320,
      y: 360 + Math.floor(column / 3) * 240,
    }),
  ]
  nextNodeIndex.value += 1
  await nextTick()
  await fitView({ padding: 0.18, duration: 240 })
}

async function resetWorkflow() {
  nodes.value = makeInitialNodes()
  edges.value = edges.value.slice(0, 2)
  nextNodeIndex.value = 4
  await nextTick()
  await fitView({ padding: 0.2, duration: 240 })
}

function nodeColor(node: { data: WorkflowAgentNodeData }) {
  if (node.data.status === 'running') return '#4a90d9'
  if (node.data.status === 'ready') return '#2e7d32'
  return '#888888'
}
</script>

<template>
  <div class="workflow-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('workflow.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" @click="resetWorkflow">
          {{ t('workflow.actions.reset') }}
        </NButton>
        <NButton type="primary" size="small" @click="addAgentNode">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('workflow.actions.addNode') }}
        </NButton>
      </div>
    </header>

    <div class="workflow-body">
      <section class="workflow-canvas" aria-label="Workflow canvas">
        <VueFlow
          id="hermes-workflow"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :fit-view-on-init="true"
          :connection-line-type="ConnectionLineType.SmoothStep"
          :default-edge-options="{ type: 'smoothstep', markerEnd: MarkerType.ArrowClosed }"
          class="workflow-flow"
          @connect="handleConnect"
          @node-context-menu="handleNodeContextMenu"
          @edge-context-menu="handleEdgeContextMenu"
          @pane-click="closeContextMenu"
        >
          <template #node-agent="nodeProps">
            <WorkflowAgentNode v-bind="nodeProps" />
          </template>

          <Background :gap="24" :size="1.2" color="var(--border-color)" />
          <MiniMap pannable zoomable :node-color="nodeColor" />
          <Controls />
        </VueFlow>
        <NDropdown
          placement="bottom-start"
          trigger="manual"
          :x="contextMenuX"
          :y="contextMenuY"
          :options="contextMenuOptions"
          :show="contextMenuVisible"
          @select="handleContextMenuSelect"
          @clickoutside="handleContextMenuClickOutside"
        />
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workflow-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.workflow-canvas {
  min-width: 0;
  min-height: 0;
  background: $bg-primary;
  flex: 1;
}

.workflow-flow {
  width: 100%;
  height: 100%;
  background: $bg-primary;

  :deep(.vue-flow__node) {
    cursor: grab;
  }

  :deep(.vue-flow__node.dragging) {
    cursor: grabbing;
  }

  :deep(.vue-flow__edge-path) {
    stroke: var(--accent-info);
    stroke-width: 2;
    stroke-dasharray: 6 6;
  }

  :deep(.vue-flow__edge.animated .vue-flow__edge-path) {
    stroke-dasharray: 6;
  }

  :deep(.vue-flow__minimap) {
    border: 1px solid $border-color;
    border-radius: 8px;
    background: $bg-card;
  }

  :deep(.vue-flow__controls) {
    border: 1px solid $border-color;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: none;
  }

  :deep(.vue-flow__controls-button) {
    background: $bg-card;
    border-bottom-color: $border-light;
    color: $text-primary;
  }
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    align-items: flex-start;
    gap: 10px;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .workflow-body {
    min-height: 420px;
  }
}
</style>
