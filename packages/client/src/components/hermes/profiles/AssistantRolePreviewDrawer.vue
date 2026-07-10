<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NDrawer, NDrawerContent, NEmpty, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { RoleContextBundle, TwinContextSection } from '@/api/hermes/assistant-roles'
import { useAssistantRoleMessages } from './assistant-role-messages'

const props = defineProps<{ show: boolean; bundle: RoleContextBundle | null }>()
const emit = defineEmits<{ close: [] }>()
const { locale } = useI18n()
const { messages: m } = useAssistantRoleMessages(locale)
const visibleSections = computed<Array<[TwinContextSection, Array<Record<string, unknown>>]>>(() => props.bundle
  ? (Object.entries(props.bundle.sections) as Array<[TwinContextSection, Array<Record<string, unknown>>]>).filter(([, records]) => records.length > 0)
  : [])
</script>

<template>
  <NDrawer :show="show" :width="640" placement="right" @update:show="!$event && emit('close')">
    <NDrawerContent :title="m.previewTitle" closable>
      <NEmpty v-if="!bundle" :description="m.previewEmpty" />
      <div v-else class="preview" data-test="server-context-bundle">
        <NAlert type="info">{{ m.serverBundle }}</NAlert>
        <NAlert v-if="bundle.truncated.total || Object.values(bundle.truncated.sections).some(Boolean)" data-test="preview-truncated" type="warning">{{ m.truncated }}</NAlert>
        <dl><dt>Role</dt><dd>{{ bundle.role.name }}</dd><dt>Profile</dt><dd>{{ bundle.profileMapping.profileName || '—' }}<NTag v-if="bundle.profileMapping.stale" type="warning">stale</NTag></dd><dt>Recipe</dt><dd>{{ bundle.recipe?.name || '—' }}</dd><dt>{{ m.query }}</dt><dd>{{ bundle.query || '—' }}</dd></dl>
        <section><h3>{{ m.rendered }}</h3><pre>{{ bundle.renderedInstructions }}</pre></section>
        <section v-for="[section, records] in visibleSections" :key="section"><h3>{{ section }} <NTag size="small">{{ records.length }}</NTag></h3><pre>{{ JSON.stringify(records, null, 2) }}</pre><div class="provenance"><strong>{{ m.provenance }}</strong><code v-for="item in bundle.provenance[section] || []" :key="item.recordId">{{ item.recordId }} · {{ item.source }}<template v-if="item.sourceId"> · {{ item.sourceId }}</template></code><code v-for="id in bundle.sourceRecordIds[section] || []" :key="`source-${id}`">{{ id }}</code></div></section>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.preview { display:flex; flex-direction:column; gap:16px; } dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 12px; margin:0; } dt { font-weight:600; } dd { margin:0; } h3 { margin:0 0 8px; } pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:12px; border-radius:8px; background:rgba(127,127,127,.08); font-size:12px; } .provenance { display:flex; flex-wrap:wrap; gap:6px; } .provenance strong { width:100%; } .provenance code { font-size:11px; padding:3px 6px; border-radius:4px; background:rgba(127,127,127,.1); }
</style>
