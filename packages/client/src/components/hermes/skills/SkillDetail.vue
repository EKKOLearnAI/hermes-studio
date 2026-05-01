<script setup lang="ts">
import { ref, watch } from 'vue'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { fetchSkillContent, fetchSkillFiles, pinSkillApi, type SkillFileEntry } from '@/api/hermes/skills'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'

const { t } = useI18n()
const message = useMessage()

const props = defineProps<{
  category: string
  skill: string
  skillName: string
  patchCount?: number
  useCount?: number
  viewCount?: number
  pinned?: boolean
}>()

const emit = defineEmits<{
  pinToggled: [name: string, pinned: boolean]
}>()

const content = ref('')
const files = ref<SkillFileEntry[]>([])
const loading = ref(false)
const fileContent = ref('')
const viewingFile = ref<string | null>(null)
const fileLoading = ref(false)

async function loadSkill() {
  loading.value = true
  viewingFile.value = null
  fileContent.value = ''
  files.value = []
  content.value = ''
  try {
    const skillPath = `${props.category}/${props.skill}/SKILL.md`
    const [skillContent, skillFiles] = await Promise.all([
      fetchSkillContent(skillPath),
      fetchSkillFiles(props.category, props.skill),
    ])
    content.value = skillContent
    files.value = skillFiles.filter(f => !f.isDir && f.path !== 'SKILL.md')
  } catch (err: any) {
    content.value = t('skills.loadFailed') + `: ${err.message}`
  } finally {
    loading.value = false
  }
}

async function viewFile(filePath: string) {
  fileLoading.value = true
  viewingFile.value = filePath
  try {
    // filePath might be absolute or relative; normalize to relative under category/skill/
    const base = `${props.category}/${props.skill}/`
    let relPath = filePath
    if (filePath.startsWith('/')) {
      // Strip absolute prefix to get relative path
      const segments = filePath.split('/.hermes/skills/')[1]
      if (segments) {
        const afterSkillDir = segments.split('/').slice(2).join('/')
        relPath = afterSkillDir
      }
    }
    fileContent.value = await fetchSkillContent(`${base}${relPath}`)
  } catch (err: any) {
    fileContent.value = t('skills.fileLoadFailed') + `: ${err.message}`
  } finally {
    fileLoading.value = false
  }
}

function backToSkill() {
  viewingFile.value = null
  fileContent.value = ''
}

const pinLoading = ref(false)

async function handlePinToggle() {
  if (pinLoading.value) return
  pinLoading.value = true
  try {
    const newPinned = !props.pinned
    await pinSkillApi(props.skillName, newPinned)
    emit('pinToggled', props.skillName, newPinned)
  } catch (err: any) {
    message.error(t('skills.pinFailed') + `: ${err.message}`)
  } finally {
    pinLoading.value = false
  }
}

watch(() => `${props.category}/${props.skill}`, loadSkill, { immediate: true })
</script>

<template>
  <div class="skill-detail">
    <!-- Skill title -->
    <div class="detail-title">
      <span class="detail-category">{{ category }}</span>
      <span class="detail-separator">/</span>
      <span class="detail-name">{{ skill }}</span>
      <div class="usage-stats">
        <button class="pin-toggle" :class="{ active: pinned }" :disabled="pinLoading" :title="pinned ? t('skills.unpin') : t('skills.pin')" @click="handlePinToggle">
          <svg width="16" height="16" viewBox="0 0 24 24" :fill="pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
        </button>
        <span v-if="viewCount != null" class="usage-stat" title="Views">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          {{ viewCount }}
        </span>
        <span v-if="useCount != null" class="usage-stat" title="Uses">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          {{ useCount }}
        </span>
        <span v-if="patchCount != null" class="usage-stat" title="Patches">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          {{ patchCount }}
        </span>
      </div>
    </div>

    <div v-if="loading && !content" class="detail-loading">{{ t('common.loading') }}</div>

    <template v-else>
      <!-- Breadcrumb for file view -->
      <div v-if="viewingFile" class="detail-breadcrumb">
        <button class="back-btn" @click="backToSkill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {{ t('skills.backTo') }} {{ skill }}
        </button>
        <span class="breadcrumb-path">{{ viewingFile }}</span>
      </div>

      <!-- Skill content -->
      <div class="detail-content">
        <MarkdownRenderer v-if="viewingFile" :content="fileContent" />
        <MarkdownRenderer v-else :content="content" />
      </div>

      <!-- Attached files -->
      <div v-if="!viewingFile && files.length > 0" class="detail-files">
        <div class="files-header">{{ t('skills.attachedFiles') }}</div>
        <div class="files-list">
          <button
            v-for="f in files"
            :key="f.path"
            class="file-item"
            @click="viewFile(f.path)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{{ f.path }}</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skill-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.detail-title {
  flex-shrink: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid $border-color;
  margin-bottom: 12px;
  font-size: 15px;
  display: flex;
  align-items: center;
}

.detail-category {
  color: $text-muted;
  font-size: 13px;
}

.detail-separator {
  color: $text-muted;
  margin: 0 6px;
}

.detail-name {
  color: $text-primary;
  font-weight: 600;
}

.usage-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  padding-left: 12px;
}

.usage-stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  color: $text-secondary;
  white-space: nowrap;

  svg {
    opacity: 0.7;
  }
}

.pin-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: none;
  color: $text-muted;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  opacity: 0.5;
  transition: all $transition-fast;

  &:hover {
    opacity: 1;
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
    border-color: rgba(var(--accent-primary-rgb), 0.15);
  }

  &.active {
    opacity: 1;
    color: $accent-primary;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.3;
  }
}

.detail-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: $text-muted;
}

.detail-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0 12px;
  border-bottom: 1px solid $border-color;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: $accent-primary;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

.breadcrumb-path {
  font-size: 13px;
  color: $text-muted;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding-bottom: 12px;

  :deep(hr) {
    border: none;
    margin: 12px 0;
  }
}

.detail-files {
  flex-shrink: 0;
  border-top: 1px solid $border-color;
  padding-top: 12px;
  margin-top: 12px;
}

.files-header {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 6px;
}

.files-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    border-color: $accent-primary;
    color: $accent-primary;
  }
}

</style>
