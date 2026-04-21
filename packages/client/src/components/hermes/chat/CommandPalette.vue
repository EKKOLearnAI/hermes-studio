<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NDropdown } from 'naive-ui'

interface Command {
  id: string
  label: string
  description?: string
}

const props = defineProps<{
  commands: Command[]
}>()

const emit = defineEmits<{
  select: [cmd: Command]
  close: []
}>()

const activeIndex = ref(0)

const dropdownOptions = computed(() =>
  props.commands.map(cmd => ({
    key: cmd.id,
    label: cmd.label,
    description: cmd.description,
  }))
)

function handleSelect(key: string) {
  const cmd = props.commands.find(c => c.id === key)
  if (cmd) emit('select', cmd)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % props.commands.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + props.commands.length) % props.commands.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (props.commands[activeIndex.value]) {
      emit('select', props.commands[activeIndex.value])
    }
  } else if (e.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <NDropdown
    trigger="manual"
    :options="dropdownOptions"
    :show="true"
    placement="top-start"
    :style="{
      width: '100%',
      background: 'var(--n-color)',
      borderRadius: '8px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
    }"
    :show-arrow="false"
    @select="handleSelect"
  >
    <template #header>
      <span style="font-size: 11px; color: var(--n-text-color-3); padding: 4px 12px;">
        {{ commands.length }} command{{ commands.length !== 1 ? 's' : '' }}
      </span>
    </template>
  </NDropdown>
</template>
