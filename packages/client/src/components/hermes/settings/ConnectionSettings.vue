<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NInput, NButton, NSpace, NAlert, NList, NListItem, NTag, NPopconfirm } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  getBaseUrlValue, setServerUrl,
  getSavedServers, addSavedServer, removeSavedServer, switchServer,
  type SavedServer,
} from '@/api/client'

const { t } = useI18n()
const serverUrl = ref('')
const serverName = ref('')
const saved = ref(false)
const currentUrl = ref('')
const servers = ref<SavedServer[]>([])

onMounted(() => {
  currentUrl.value = getBaseUrlValue()
  serverUrl.value = currentUrl.value
  servers.value = getSavedServers()
})

function handleSave() {
  const url = serverUrl.value.trim().replace(/\/+$/, '')
  setServerUrl(url)
  currentUrl.value = url
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

function handleReset() {
  setServerUrl('')
  serverUrl.value = ''
  currentUrl.value = ''
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

function handleAddToList() {
  const url = serverUrl.value.trim().replace(/\/+$/, '')
  if (!url) return
  addSavedServer(url, serverName.value.trim() || url)
  servers.value = getSavedServers()
  serverName.value = ''
}

function handleRemoveFromList(url: string) {
  removeSavedServer(url)
  servers.value = getSavedServers()
}

function handleSwitchTo(url: string) {
  switchServer(url)
  currentUrl.value = url
  serverUrl.value = url
  // Reload to apply new backend — clears all state
  window.location.reload()
}

function isActive(url: string): boolean {
  return currentUrl.value === url || (!currentUrl.value && !url)
}
</script>

<template>
  <div class="connection-settings">
    <NCard :title="t('settings.connection.title')" size="small">
      <div class="setting-description">
        {{ t('settings.connection.description') }}
      </div>

      <div class="setting-description" style="margin-bottom: 12px;">
        {{ t('settings.connection.corsHint') }}
      </div>

      <!-- Add new server -->
      <div class="add-server-row">
        <NInput
          v-model:value="serverName"
          :placeholder="t('settings.connection.namePlaceholder')"
          size="small"
          style="margin-bottom: 8px;"
        />
        <div class="url-input-row">
          <NInput
            v-model:value="serverUrl"
            :placeholder="t('settings.connection.placeholder')"
            clearable
            @keyup.enter="handleSave"
          />
        </div>
      </div>

      <div class="current-url" v-if="currentUrl">
        <span class="label">{{ t('settings.connection.current') }}:</span>
        <code>{{ currentUrl }}</code>
      </div>
      <div class="current-url" v-else>
        <span class="label">{{ t('settings.connection.current') }}:</span>
        <code>{{ t('settings.connection.same_origin') }}</code>
      </div>

      <NSpace>
        <NButton type="primary" size="small" @click="handleSave">
          {{ t('common.save') }}
        </NButton>
        <NButton size="small" @click="handleAddToList">
          {{ t('settings.connection.saveToList') }}
        </NButton>
        <NButton size="small" @click="handleReset">
          {{ t('settings.connection.reset') }}
        </NButton>
      </NSpace>

      <NAlert v-if="saved" type="success" :title="t('settings.connection.saved')" style="margin-top: 12px;">
        {{ t('settings.connection.reload_hint') }}
      </NAlert>

      <!-- Saved servers list -->
      <div v-if="servers.length > 0" class="saved-servers-section">
        <div class="section-title">{{ t('settings.connection.savedServers') }}</div>
        <NList bordered size="small" hoverable>
          <NListItem v-for="server in servers" :key="server.url">
            <div class="server-item">
              <div class="server-info">
                <span class="server-name">{{ server.name }}</span>
                <code class="server-url">{{ server.url }}</code>
              </div>
              <div class="server-actions">
                <NTag v-if="isActive(server.url)" type="success" size="small">
                  {{ t('settings.connection.active') }}
                </NTag>
                <NButton
                  v-else
                  size="tiny"
                  type="primary"
                  quaternary
                  @click="handleSwitchTo(server.url)"
                >
                  {{ t('settings.connection.switch') }}
                </NButton>
                <NPopconfirm @positive-click="handleRemoveFromList(server.url)">
                  <template #trigger>
                    <NButton size="tiny" type="error" quaternary>
                      {{ t('common.delete') }}
                    </NButton>
                  </template>
                  {{ t('settings.connection.removeConfirm') }}
                </NPopconfirm>
              </div>
            </div>
          </NListItem>
        </NList>
      </div>
    </NCard>
  </div>
</template>

<style scoped lang="scss">
.connection-settings {
  max-width: 600px;
}

.setting-description {
  color: var(--n-text-color-3);
  font-size: 13px;
  margin-bottom: 16px;
  line-height: 1.5;
}

.url-input-row {
  margin-bottom: 12px;
}

.current-url {
  margin-bottom: 16px;
  font-size: 13px;

  .label {
    color: var(--n-text-color-3);
    margin-right: 4px;
  }

  code {
    background: var(--n-code-color);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
}

.saved-servers-section {
  margin-top: 20px;
}

.section-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--n-text-color);
}

.server-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

.server-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.server-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--n-text-color);
}

.server-url {
  font-size: 11px;
  color: var(--n-text-color-3);
  word-break: break-all;
}

.server-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
</style>
