<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useFilesStore } from '@/stores/hermes/files'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import type { FileEntry } from '@/api/hermes/files'

const filesStore = useFilesStore()
const { t } = useI18n()

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
const showUpload = ref(false)
const showRenameModal = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)
const showSidebar = ref(false)

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  showRenameModal.value = true
}

onMounted(() => {
  filesStore.fetchEntries('')
})
</script>

<template>
  <div class="files-panel-drawer">
    <div
      v-if="showSidebar"
      class="sidebar-overlay"
      @click="showSidebar = false"
    ></div>
    <div
      class="files-tree-panel"
      :class="{ 'mobile-visible': showSidebar }"
    >
      <FileTree />
    </div>
    <div class="files-main-panel">
      <div class="main-toolbar">
        <NButton
          size="small"
          @click="showSidebar = !showSidebar"
          class="sidebar-toggle"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </template>
          {{ t('files.fileTree') }}
        </NButton>
        <FileToolbar
          @show-new-file="handleShowNewFile"
          @show-new-folder="handleShowNewFolder"
          @show-upload="showUpload = true"
        />
      </div>
      <FileBreadcrumb />
      <div class="files-content">
        <FileEditor v-if="filesStore.editingFile" />
        <FilePreview v-else-if="filesStore.previewFile" />
        <FileList v-else @contextmenu-entry="handleContextMenu" />
      </div>
    </div>
    <FileContextMenu ref="contextMenuRef" @rename="handleRename" />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal v-model:show="showRenameModal" :mode="renameMode" :entry="renameEntry" />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.files-panel-drawer {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.sidebar-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 50;

  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }
}

.files-tree-panel {
  width: 200px;
  min-width: 150px;
  max-width: 300px;
  border-right: 1px solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;

  @media (max-width: $breakpoint-mobile) {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 80%;
    max-width: 300px;
    z-index: 51;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
    transform: translateX(-100%);
    transition: transform 0.3s ease;

    &.mobile-visible {
      transform: translateX(0);
    }
  }
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.main-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    gap: 4px;
    padding: 8px 8px;
    flex-wrap: wrap;
  }
}

.sidebar-toggle {
  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }

  @media (max-width: $breakpoint-mobile) {
    font-size: 12px;
    padding: 0 8px;
    height: 32px;
  }
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
