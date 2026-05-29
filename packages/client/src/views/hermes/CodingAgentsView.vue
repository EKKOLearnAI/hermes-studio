<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchCodingAgentsStatus,
  installCodingAgent,
  type CodingAgentId,
  type CodingAgentToolStatus,
} from '@/api/coding-agents'
import { copyToClipboard } from '@/utils/clipboard'

type CodingAgentCommand = {
  id: CodingAgentId
  tool: 'Claude Code' | 'Codex'
  provider: 'Anthropic' | 'OpenAI'
  kindKey: string
  command: string
  noteKey: string
}

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const loadError = ref('')
const tools = ref<CodingAgentToolStatus[]>([])
const installing = ref<Record<CodingAgentId, boolean>>({
  'claude-code': false,
  codex: false,
})

const agentLogos: Record<CodingAgentCommand['tool'], string> = {
  'Claude Code': '/coding-agents/claude-code.svg',
  Codex: '/coding-agents/codex-openai.png',
}

const agentBlocks: Array<{
  id: CodingAgentId
  tool: CodingAgentCommand['tool']
  provider: CodingAgentCommand['provider']
  descriptionKey: string
}> = [
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
    descriptionKey: 'codingAgents.claudeDescription',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
    descriptionKey: 'codingAgents.codexDescription',
  },
]

const commands: CodingAgentCommand[] = [
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
    kindKey: 'codingAgents.kinds.install',
    command: 'npm install -g @anthropic-ai/claude-code',
    noteKey: 'codingAgents.notes.claudeInstall',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
    kindKey: 'codingAgents.kinds.install',
    command: 'npm install -g @openai/codex',
    noteKey: 'codingAgents.notes.codexInstall',
  },
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
    kindKey: 'codingAgents.kinds.auth',
    command: 'claude auth status --text',
    noteKey: 'codingAgents.notes.claudeAuth',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
    kindKey: 'codingAgents.kinds.auth',
    command: 'hermes auth add openai-codex',
    noteKey: 'codingAgents.notes.codexAuth',
  },
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
    kindKey: 'codingAgents.kinds.health',
    command: 'claude doctor',
    noteKey: 'codingAgents.notes.claudeHealth',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
    kindKey: 'codingAgents.kinds.health',
    command: 'codex --version',
    noteKey: 'codingAgents.notes.codexHealth',
  },
  {
    id: 'claude-code',
    tool: 'Claude Code',
    provider: 'Anthropic',
    kindKey: 'codingAgents.kinds.run',
    command: "claude -p 'Review this repository and report the top risks' --max-turns 10",
    noteKey: 'codingAgents.notes.claudeRun',
  },
  {
    id: 'codex',
    tool: 'Codex',
    provider: 'OpenAI',
    kindKey: 'codingAgents.kinds.run',
    command: "codex exec 'Review this repository and report the top risks'",
    noteKey: 'codingAgents.notes.codexRun',
  },
]

const statusById = computed(() => {
  return tools.value.reduce((acc, tool) => {
    acc[tool.id] = tool
    return acc
  }, {} as Partial<Record<CodingAgentId, CodingAgentToolStatus>>)
})

function providerTagType(provider: CodingAgentCommand['provider']) {
  return provider === 'OpenAI' ? 'info' : 'success'
}

function commandsFor(tool: CodingAgentCommand['tool']) {
  return commands.filter(item => item.tool === tool)
}

function statusFor(id: CodingAgentId) {
  return statusById.value[id]
}

async function loadStatus() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchCodingAgentsStatus()
    tools.value = data.tools
  } catch (err: any) {
    loadError.value = err?.message || t('codingAgents.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleInstall(id: CodingAgentId) {
  installing.value[id] = true
  try {
    const result = await installCodingAgent(id)
    tools.value = result.tools
    if (result.success) {
      message.success(t('codingAgents.installSuccess'))
    } else {
      message.error(result.message || t('codingAgents.installFailed'))
    }
  } catch (err: any) {
    message.error(err?.message || t('codingAgents.installFailed'))
  } finally {
    installing.value[id] = false
  }
}

async function copyCommand(command: string) {
  const ok = await copyToClipboard(command)
  if (ok) {
    message.success(t('codingAgents.commandCopied'))
  } else {
    message.error(t('codingAgents.commandCopyFailed'))
  }
}

onMounted(loadStatus)
</script>

<template>
  <div class="coding-agents-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('codingAgents.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadStatus">
        {{ t('codingAgents.refresh') }}
      </NButton>
    </header>

    <div class="coding-agents-content">
      <NAlert v-if="loadError" type="error" class="status-alert">
        {{ loadError }}
      </NAlert>

      <div class="agent-blocks">
        <section v-for="block in agentBlocks" :key="block.tool" class="agent-block">
          <header class="agent-block-header">
            <img class="agent-logo" :src="agentLogos[block.tool]" alt="" />
            <div>
              <h3>{{ block.tool }}</h3>
              <p>{{ t(block.descriptionKey) }}</p>
            </div>
            <NTag size="small" :type="providerTagType(block.provider)">{{ block.provider }}</NTag>
          </header>

          <div class="agent-install-state">
            <NTag v-if="loading && !statusFor(block.id)" size="small">
              {{ t('codingAgents.checking') }}
            </NTag>
            <template v-else-if="statusFor(block.id)?.installed">
              <NTag size="small" type="success">{{ t('codingAgents.installed') }}</NTag>
              <span class="version-text">
                {{ statusFor(block.id)?.version || statusFor(block.id)?.rawVersion }}
              </span>
            </template>
            <template v-else>
              <NTag size="small" type="warning">{{ t('codingAgents.notInstalled') }}</NTag>
              <NButton
                size="small"
                type="primary"
                secondary
                :loading="installing[block.id]"
                @click="handleInstall(block.id)"
              >
                {{ installing[block.id] ? t('codingAgents.installing') : t('codingAgents.installNow') }}
              </NButton>
            </template>
          </div>

          <div class="command-list">
            <div v-for="item in commandsFor(block.tool)" :key="item.kindKey" class="command-row">
              <div class="command-meta">
                <NTag size="small" round>{{ t(item.kindKey) }}</NTag>
                <span>{{ t(item.noteKey) }}</span>
              </div>
              <div class="command-action">
                <code class="command-cell">{{ item.command }}</code>
                <NButton size="tiny" secondary @click="copyCommand(item.command)">
                  {{ t('codingAgents.copyCommand') }}
                </NButton>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.coding-agents-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.coding-agents-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: $bg-secondary;
}

.agent-blocks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.agent-block {
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: $bg-card;
  overflow: hidden;
}

.status-alert {
  margin-bottom: 14px;
}

.agent-block-header {
  padding: 14px;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: flex-start;
  gap: 12px;
  border-bottom: 1px solid $border-light;

  h3 {
    margin: 0 0 6px;
    font-size: 16px;
    line-height: 1.2;
  }

  p {
    margin: 0;
    color: $text-secondary;
    font-size: 13px;
    line-height: 1.45;
  }
}

.agent-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  border-radius: 8px;
  background: $bg-secondary;
  padding: 6px;
}

.agent-install-state {
  min-height: 42px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid $border-light;
}

.version-text {
  min-width: 0;
  color: $text-secondary;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-list {
  display: flex;
  flex-direction: column;
}

.command-row {
  padding: 12px 14px;
  display: grid;
  grid-template-columns: minmax(160px, 0.7fr) minmax(0, 1.3fr);
  gap: 12px;
  border-bottom: 1px solid $border-light;

  &:last-child {
    border-bottom: none;
  }
}

.command-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.4;
}

.command-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.command-cell {
  display: inline-block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: $text-secondary;
  background: $code-bg;
  padding: 3px 6px;
  border-radius: 6px;
}

@media (max-width: 760px) {
  .agent-blocks,
  .command-row,
  .command-action {
    grid-template-columns: 1fr;
  }

  .coding-agents-content {
    padding: 14px;
  }
}
</style>
