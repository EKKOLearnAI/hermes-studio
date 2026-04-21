<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NTree } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import * as filesApi from '@/api/hermes/files'
import type { TreeOption } from 'naive-ui'

const { t } = useI18n()
const filesStore = useFilesStore()

const treeData = ref<TreeOption[]>([])
const selectedKeys = ref<string[]>([])

async function loadChildren(path: string): Promise<TreeOption[]> {
  try {
    const result = await filesApi.listFiles(path)
    return result.entries
      .filter(e => e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        key: e.path,
        label: e.name,
        isLeaf: false,
      }))
  } catch {
    return []
  }
}

async function handleLoad(node: TreeOption): Promise<void> {
  node.children = await loadChildren(node.key as string)
}

function handleSelect(keys: string[]) {
  if (keys.length > 0) {
    selectedKeys.value = keys
    filesStore.navigateTo(keys[0])
  }
}

function handleRootClick() {
  selectedKeys.value = []
  filesStore.navigateTo('')
}

onMounted(async () => {
  treeData.value = await loadChildren('')
})
</script>

<template>
  <div class="file-tree">
    <div class="tree-header" @click="handleRootClick">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
      <span>{{ t('files.breadcrumbRoot') }}</span>
    </div>
    <NTree
      :data="treeData"
      :selected-keys="selectedKeys"
      :on-load="handleLoad"
      expand-on-click
      block-line
      @update:selected-keys="handleSelect"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-tree {
  padding: 8px;
}

.tree-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: $radius-sm;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
  }
}
</style>
