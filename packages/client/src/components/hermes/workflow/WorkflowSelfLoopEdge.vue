<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, type EdgeProps } from '@vue-flow/core'
import { workflowSelfLoopPath, type WorkflowHandlePosition } from '@/utils/workflow-edge-authoring'

const props = defineProps<EdgeProps>()

const nodeBounds = computed(() => ({
  left: props.sourceNode.computedPosition.x,
  top: props.sourceNode.computedPosition.y,
  right: props.sourceNode.computedPosition.x + props.sourceNode.dimensions.width,
  bottom: props.sourceNode.computedPosition.y + props.sourceNode.dimensions.height,
}))

const path = computed(() => workflowSelfLoopPath({
  sourceX: props.sourceX,
  sourceY: props.sourceY,
  sourcePosition: props.sourcePosition as WorkflowHandlePosition,
  targetX: props.targetX,
  targetY: props.targetY,
  targetPosition: props.targetPosition as WorkflowHandlePosition,
  nodeBounds: nodeBounds.value,
}))
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path"
    :marker-start="markerStart"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :style="style"
  />
</template>
