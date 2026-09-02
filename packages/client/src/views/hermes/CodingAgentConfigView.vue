<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NTag, useMessage } from 'naive-ui'
import {
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
  type CodingAgentConfigFileContent,
  type CodingAgentId,
} from '@/api/coding-agents'
import type { SkillTarget } from '@/api/hermes/skills'
import SkillsView from '@/views/hermes/SkillsView.vue'

const route = useRoute()
const { t } = useI18n()
const message = useMessage()

const agentNames: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok',
}

const sectionLabels = computed<Record<string, string>>(() => ({
  memory: t('sidebar.memory'),
  skills: t('sidebar.skills'),
  mcp: t('sidebar.mcp'),
  settings: t('sidebar.settings'),
}))

const agentId = computed(() => String(route.params.agentId || ''))
const section = computed(() => String(route.params.section || 'settings'))
const agentName = computed(() => agentNames[agentId.value] || agentId.value)
const sectionLabel = computed(() => sectionLabels.value[section.value] || t('sidebar.settings'))

type EditableSection = 'memory' | 'mcp' | 'settings'

const configKeys: Record<CodingAgentId, Record<EditableSection, string>> = {
  'claude-code': { memory: 'memory', mcp: 'mcp', settings: 'settings' },
  codex: { memory: 'agents', mcp: 'config', settings: 'config' },
  pi: { memory: 'agents', mcp: 'mcp', settings: 'settings' },
  grok: { memory: 'agents', mcp: 'config', settings: 'config' },
}

const skillTargets: Record<CodingAgentId, SkillTarget> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
}

const configFile = ref<CodingAgentConfigFileContent | null>(null)
const content = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const validAgentId = computed<CodingAgentId | null>(() =>
  agentId.value in configKeys ? agentId.value as CodingAgentId : null,
)
const editableSection = computed<EditableSection | null>(() =>
  section.value === 'memory' || section.value === 'mcp' || section.value === 'settings'
    ? section.value
    : null,
)
const configKey = computed(() => {
  if (!validAgentId.value || !editableSection.value) return ''
  return configKeys[validAgentId.value][editableSection.value]
})
const skillTarget = computed<SkillTarget>(() =>
  validAgentId.value ? skillTargets[validAgentId.value] : 'hermes',
)
const dirty = computed(() => content.value !== (configFile.value?.content || ''))

async function loadConfigFile() {
  configFile.value = null
  content.value = ''
  error.value = ''
  if (!validAgentId.value || !configKey.value) return

  loading.value = true
  try {
    const file = await readCodingAgentConfigFile(validAgentId.value, configKey.value)
    configFile.value = file
    content.value = file.content
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function saveConfigFile() {
  if (!validAgentId.value || !configKey.value || saving.value) return
  saving.value = true
  try {
    const file = await writeCodingAgentConfigFile(validAgentId.value, configKey.value, content.value)
    configFile.value = file
    content.value = file.content
    message.success(t('files.saveFile'))
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

watch([agentId, section], loadConfigFile, { immediate: true })
</script>

<template>
  <div class="coding-agent-config-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ agentName }} · {{ sectionLabel }}</h2>
        <p v-if="section !== 'skills'" class="header-description">
          {{ configFile?.path || agentId }}
        </p>
      </div>
    </header>

    <div v-if="section === 'skills'" class="coding-agent-skills-content">
      <SkillsView :target="skillTarget" embedded />
    </div>

    <div v-else class="coding-agent-config-content">
      <NSpin v-if="loading" />
      <div v-else-if="error" class="config-error">
        <p>{{ error }}</p>
        <NButton size="small" @click="loadConfigFile">{{ t('common.retry') }}</NButton>
      </div>
      <template v-else-if="configKey">
        <div class="editor-toolbar">
          <div class="file-meta">
            <code>{{ configFile?.absolutePath || configFile?.path }}</code>
            <NTag v-if="configFile && !configFile.exists" size="small" :bordered="false">
              {{ t('codingAgents.configFileNotCreated') }}
            </NTag>
          </div>
          <NButton
            type="primary"
            size="small"
            :disabled="!dirty"
            :loading="saving"
            @click="saveConfigFile"
          >
            {{ t('files.saveFile') }}
          </NButton>
        </div>
        <NInput
          v-model:value="content"
          class="config-editor"
          type="textarea"
          :autosize="{ minRows: 18 }"
          :placeholder="configFile?.path"
        />
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.coding-agent-config-view {
  min-height: 100%;
  padding: 20px;
  background: $bg-main-surface;
}

.page-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}

.header-title {
  margin: 0;
  color: $text-primary;
  font-size: 20px;
}

.header-description {
  margin: 6px 0 0;
  color: $text-muted;
  font-size: 13px;
}

.coding-agent-config-content {
  min-height: 320px;
  padding: 16px;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: $bg-card;
}

.coding-agent-config-content > .n-spin {
  display: block;
  margin: 120px auto;
}

.coding-agent-skills-content {
  min-height: 420px;
  padding: 16px;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: $bg-card;
}

.editor-toolbar,
.file-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.editor-toolbar {
  justify-content: space-between;
  margin-bottom: 12px;
}

.file-meta {
  min-width: 0;
  color: $text-muted;
  font-size: 12px;
}

.file-meta code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-editor {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.config-error {
  display: grid;
  min-height: 280px;
  place-content: center;
  justify-items: center;
  color: $text-muted;
  text-align: center;
}
</style>
