<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCard, NGrid, NGi, NSpin, NTag } from 'naive-ui'
import { fetchCodeIntelligenceSummary, type CodeIntelligenceSummary, type CodeLanguageStatus } from '@/api/hermes/code-intelligence'

const { t } = useI18n()
const loading = ref(false)
const error = ref('')
const summary = ref<CodeIntelligenceSummary | null>(null)

const primaryLanguages = computed(() => {
  const languages = summary.value?.languages ?? {}
  return ['TypeScript', 'Vue', 'Python', 'C/C++'].map((name) => ({
    name,
    files: languages[name]?.files ?? 0,
    lines: languages[name]?.lines ?? 0,
    status: languages[name]?.status ?? 'not_detected',
  }))
})

const otherLanguages = computed(() => {
  const languages = summary.value?.languages ?? {}
  return Object.entries(languages)
    .filter(([name]) => !['TypeScript', 'Vue', 'Python', 'C/C++'].includes(name))
    .filter(([, item]) => item.files > 0)
    .map(([name, item]) => ({ name, ...item }))
})

function tagType(status: CodeLanguageStatus) {
  if (status === 'detected') return 'success'
  if (status === 'partial') return 'warning'
  return 'default'
}

async function loadSummary() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await fetchCodeIntelligenceSummary()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(loadSummary)
</script>

<template>
  <div class="code-intelligence-view">
    <header class="page-header">
      <div>
        <h1>{{ t('codeIntelligence.title') }}</h1>
        <p>{{ t('codeIntelligence.subtitle') }}</p>
      </div>
      <NButton type="primary" :loading="loading" @click="loadSummary">
        {{ t('common.refresh') }}
      </NButton>
    </header>

    <NAlert v-if="error" type="error" class="section">
      {{ error }}
    </NAlert>

    <NSpin :show="loading && !summary">
      <div v-if="summary" class="content">
        <NCard class="section" :title="t('codeIntelligence.repository')">
          <div class="meta-row">
            <span class="meta-label">{{ t('codeIntelligence.root') }}</span>
            <code>{{ summary.root }}</code>
          </div>
          <div class="meta-row">
            <span class="meta-label">{{ t('codeIntelligence.generatedAt') }}</span>
            <span>{{ new Date(summary.generatedAt).toLocaleString() }}</span>
          </div>
        </NCard>

        <NGrid :cols="4" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <NGi v-for="language in primaryLanguages" :key="language.name" span="4 s:2 m:1">
            <NCard class="language-card">
              <div class="card-title-row">
                <strong>{{ language.name }}</strong>
                <NTag size="small" :type="tagType(language.status)">{{ language.status }}</NTag>
              </div>
              <div class="metric">{{ language.files }} {{ t('codeIntelligence.files') }}</div>
              <div class="submetric">{{ language.lines.toLocaleString() }} {{ t('codeIntelligence.lines') }}</div>
            </NCard>
          </NGi>
        </NGrid>

        <NGrid class="section" :cols="2" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <NGi span="2 m:1">
            <NCard :title="t('codeIntelligence.capabilities')">
              <div v-for="(capability, key) in summary.capabilities" :key="key" class="capability-row">
                <div>
                  <strong>{{ key }}</strong>
                  <p>{{ capability.reason }}</p>
                </div>
                <NTag size="small" :type="tagType(capability.status)">{{ capability.status }}</NTag>
              </div>
            </NCard>
          </NGi>
          <NGi span="2 m:1">
            <NCard :title="t('codeIntelligence.recommendedSkills')">
              <div class="tag-list">
                <NTag v-for="skill in summary.recommendedSkills" :key="skill" type="info">
                  {{ skill }}
                </NTag>
              </div>
            </NCard>
          </NGi>
        </NGrid>

        <NGrid class="section" :cols="2" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <NGi span="2 m:1">
            <NCard :title="t('codeIntelligence.manifests')">
              <ul v-if="summary.manifests.length" class="plain-list">
                <li v-for="manifest in summary.manifests" :key="manifest.path">
                  <strong>{{ manifest.name }}</strong>
                  <code>{{ manifest.path }}</code>
                </li>
              </ul>
              <p v-else class="empty-text">{{ t('codeIntelligence.noManifests') }}</p>
            </NCard>
          </NGi>
          <NGi span="2 m:1">
            <NCard :title="t('codeIntelligence.suggestedActions')">
              <ul class="plain-list">
                <li>{{ t('codeIntelligence.actionAnalyze') }}</li>
                <li>{{ t('codeIntelligence.actionTests') }}</li>
                <li>{{ t('codeIntelligence.actionPr') }}</li>
                <li>{{ t('codeIntelligence.actionCpp') }}</li>
              </ul>
            </NCard>
          </NGi>
        </NGrid>

        <NCard v-if="otherLanguages.length" class="section" :title="t('codeIntelligence.otherLanguages')">
          <div class="tag-list">
            <NTag v-for="language in otherLanguages" :key="language.name">
              {{ language.name }}: {{ language.files }} / {{ language.lines.toLocaleString() }}
            </NTag>
          </div>
        </NCard>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.code-intelligence-view {
  padding: 24px;
  max-width: 1180px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;

  h1 {
    margin: 0 0 6px;
    font-size: 28px;
  }

  p {
    margin: 0;
    color: var(--text-secondary, #6b7280);
  }
}

.section {
  margin-top: 16px;
}

.language-card {
  min-height: 126px;
}

.card-title-row,
.capability-row,
.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.capability-row + .capability-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #e5e7eb);
}

.capability-row p {
  margin: 4px 0 0;
  color: var(--text-secondary, #6b7280);
}

.meta-row + .meta-row {
  margin-top: 10px;
}

.meta-label {
  color: var(--text-secondary, #6b7280);
  min-width: 120px;
}

.metric {
  margin-top: 20px;
  font-size: 24px;
  font-weight: 700;
}

.submetric,
.empty-text {
  margin-top: 4px;
  color: var(--text-secondary, #6b7280);
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plain-list {
  margin: 0;
  padding-left: 18px;

  li + li {
    margin-top: 8px;
  }

  code {
    margin-left: 8px;
  }
}
</style>
