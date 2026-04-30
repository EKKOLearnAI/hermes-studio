<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { NSpin } from 'naive-ui'
import { request } from '@/api/client'

interface FolderEntry {
  name: string
  path: string
  fullPath: string
}

interface FolderListResponse {
  base: string
  current: string
  folders: FolderEntry[]
}

/** Flat display node for rendering tree without recursion */
interface FlatNode {
  folder: FolderEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  hasChildren: boolean | null  // null = unknown
}

const props = defineProps<{
  modelValue: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const loading = ref(false)
const basePath = ref('')
const folders = ref<FolderEntry[]>([])
const expandedPaths = ref<Set<string>>(new Set())
const childrenCache = ref<Map<string, FolderEntry[]>>(new Map())
const loadingPaths = ref<Set<string>>(new Set())
const selectedPath = ref(props.modelValue || '')

watch(() => props.modelValue, (v) => { selectedPath.value = v || '' })

async function loadFolders(subPath = ''): Promise<FolderListResponse | null> {
  try {
    const query = subPath ? `?path=${encodeURIComponent(subPath)}` : ''
    return await request<FolderListResponse>(`/api/hermes/workspace/folders${query}`)
  } catch {
    return null
  }
}

onMounted(async () => {
  loading.value = true
  const res = await loadFolders()
  if (res) {
    basePath.value = res.base
    folders.value = res.folders
  }
  loading.value = false
})

async function toggleExpand(folder: FolderEntry) {
  if (expandedPaths.value.has(folder.path)) {
    expandedPaths.value.delete(folder.path)
    expandedPaths.value = new Set(expandedPaths.value)
    return
  }

  expandedPaths.value.add(folder.path)
  expandedPaths.value = new Set(expandedPaths.value)

  if (!childrenCache.value.has(folder.path)) {
    loadingPaths.value.add(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
    const res = await loadFolders(folder.path)
    childrenCache.value.set(folder.path, res?.folders || [])
    childrenCache.value = new Map(childrenCache.value)
    loadingPaths.value.delete(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
  }
}

function selectFolder(folder: FolderEntry) {
  const fullPath = `${basePath.value}/${folder.path}`
  selectedPath.value = fullPath
  emit('update:modelValue', fullPath)
}

function selectBase() {
  selectedPath.value = basePath.value
  emit('update:modelValue', basePath.value)
}

/** Build a flat list by DFS traversal of expanded nodes */
const flatNodes = computed<FlatNode[]>(() => {
  const result: FlatNode[] = []

  function traverse(entries: FolderEntry[], depth: number) {
    for (const folder of entries) {
      const isExpanded = expandedPaths.value.has(folder.path)
      const isLoading = loadingPaths.value.has(folder.path)
      const children = childrenCache.value.get(folder.path)
      result.push({
        folder,
        depth,
        isExpanded,
        isLoading,
        hasChildren: children ? children.length > 0 : null,
      })
      if (isExpanded && children && children.length > 0) {
        traverse(children, depth + 1)
      }
    }
  }

  traverse(folders.value, 0)
  return result
})
</script>

<template>
  <div class="folder-picker">
    <div v-if="loading" class="folder-picker-loading">
      <NSpin size="small" />
    </div>
    <div v-else class="folder-tree">
      <!-- Base path as root -->
      <div
        class="folder-item root"
        :class="{ selected: selectedPath === basePath }"
        @click="selectBase"
      >
        <span class="folder-icon">📂</span>
        <span class="folder-name">{{ basePath || '/' }}</span>
      </div>

      <!-- Flat rendered tree -->
      <div
        v-for="node in flatNodes"
        :key="node.folder.path"
        class="folder-item"
        :class="{ selected: selectedPath === `${basePath}/${node.folder.path}` }"
        :style="{ paddingLeft: `${12 + node.depth * 16}px` }"
      >
        <span class="folder-expand" @click.stop="toggleExpand(node.folder)">
          <template v-if="node.isLoading">⏳</template>
          <template v-else>{{ node.isExpanded ? '▼' : '▶' }}</template>
        </span>
        <span class="folder-icon" @click="selectFolder(node.folder)">📁</span>
        <span class="folder-name" @click="selectFolder(node.folder)">{{ node.folder.name }}</span>
      </div>

      <!-- Empty children indicator for expanded folders with no children -->
      <template v-for="node in flatNodes" :key="'empty-' + node.folder.path">
        <div
          v-if="node.isExpanded && !node.isLoading && node.hasChildren === false"
          class="folder-item empty"
          :style="{ paddingLeft: `${28 + node.depth * 16}px` }"
        >
          <span class="folder-empty-text">（空）</span>
        </div>
      </template>

      <div v-if="folders.length === 0 && !loading" class="folder-empty">
        暂无工作区文件夹
      </div>
    </div>

    <!-- Selected path display -->
    <div v-if="selectedPath" class="folder-selected">
      <span class="folder-selected-label">已选择：</span>
      <span class="folder-selected-path">{{ selectedPath }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.folder-picker {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
}

.folder-picker-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.folder-tree {
  font-size: 13px;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  &.selected {
    background: rgba(64, 158, 255, 0.15);
    outline: 1px solid rgba(64, 158, 255, 0.4);
  }

  &.root {
    font-weight: 600;
    margin-bottom: 4px;
  }

  &.empty {
    opacity: 0.5;
    cursor: default;
  }
}

.folder-expand {
  width: 14px;
  font-size: 10px;
  text-align: center;
  flex-shrink: 0;
  user-select: none;
  opacity: 0.6;
}

.folder-icon {
  flex-shrink: 0;
}

.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-empty-text {
  font-size: 11px;
  opacity: 0.5;
  font-style: italic;
}

.folder-empty {
  text-align: center;
  padding: 16px;
  opacity: 0.5;
}

.folder-selected {
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(64, 158, 255, 0.08);
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  gap: 4px;
  align-items: center;
}

.folder-selected-label {
  opacity: 0.6;
  flex-shrink: 0;
}

.folder-selected-path {
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
