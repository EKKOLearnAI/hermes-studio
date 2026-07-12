<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ActionControlDto, EmergencyStopInput } from '@/api/hermes/action-fabric'
import { useActionFabricMessages } from './action-fabric-messages'

const props = defineProps<{ control: ActionControlDto | null; saving: boolean }>()
const emit = defineEmits<{ update: [input: EmergencyStopInput] }>()
const dialog = useDialog()
const { locale } = useI18n()
const { messages: m } = useActionFabricMessages(locale)
const selectedLevel = ref<0 | 1 | 2 | 3>(0)
const reason = ref('')
watch(() => props.control?.level, level => { if (level !== undefined) selectedLevel.value = level }, { immediate: true })
const levels = computed(() => [
  { level: 0 as const, title: m.value.level0, description: m.value.level0Description },
  { level: 1 as const, title: m.value.level1, description: m.value.level1Description },
  { level: 2 as const, title: m.value.level2, description: m.value.level2Description },
  { level: 3 as const, title: m.value.level3, description: m.value.level3Description },
])
const canApply = computed(() => Boolean(props.control && selectedLevel.value !== props.control.level && reason.value.trim() && !props.saving))

function apply(): void {
  if (!props.control || !canApply.value) return
  const input: EmergencyStopInput = { level: selectedLevel.value, reason: reason.value.trim(), expectedVersion: props.control.version }
  dialog.warning({ title: m.value.confirmControl, content: levels.value[selectedLevel.value].description, positiveText: m.value.applyControl, negativeText: m.value.cancel, onPositiveClick: () => emit('update', input) })
}
</script>

<template>
  <section class="emergency" aria-labelledby="emergency-title">
    <h3 id="emergency-title">{{ m.emergencyStop }}</h3>
    <p v-if="control" data-test="emergency-current"><strong>{{ m.currentControl }}:</strong> {{ levels[control.level].title }} · {{ m.version }} {{ control.version }} · {{ m.lastUpdated }} {{ control.updatedAt || '—' }}</p>
    <fieldset :disabled="saving || !control" :aria-label="m.chooseLevel">
      <legend>{{ m.chooseLevel }}</legend>
      <label v-for="item in levels" :key="item.level" :data-test="`emergency-level-${item.level}`" class="level-option">
        <input v-model.number="selectedLevel" type="radio" name="emergency-level" :value="item.level" :data-test="`emergency-level-input-${item.level}`">
        <span><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span>
      </label>
    </fieldset>
    <label class="reason-label">{{ m.controlReason }}<textarea v-model="reason" data-test="emergency-reason" rows="2" :disabled="saving" /></label>
    <p v-if="!reason.trim()" role="status" aria-live="polite">{{ m.reasonRequired }}</p>
    <button data-test="apply-emergency-stop" type="button" :disabled="!canApply" @click="apply">{{ saving ? m.saving : m.applyControl }}</button>
  </section>
</template>

<style scoped lang="scss">
.emergency { display:flex; flex-direction:column; gap:12px; padding:14px; border:1px solid var(--border-color); border-radius:10px; } h3,p { margin:0; } fieldset { display:grid; gap:8px; border:0; padding:0; margin:0; } .level-option { display:flex; gap:10px; align-items:flex-start; padding:10px; border:1px solid var(--border-color); border-radius:8px; cursor:pointer; } .level-option span,.reason-label { display:flex; flex-direction:column; gap:4px; } small { opacity:.75; } textarea { width:100%; box-sizing:border-box; resize:vertical; } button { align-self:flex-start; padding:8px 14px; cursor:pointer; }
</style>
