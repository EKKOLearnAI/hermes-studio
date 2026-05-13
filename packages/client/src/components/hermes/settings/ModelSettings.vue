<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { NInput, NButton, NSpin, NEmpty, NSelect, useDialog, useMessage } from 'naive-ui'
import { useModelsStore } from '@/stores/hermes/models'
import { updateProvider } from '@/api/hermes/system'
import {
  deleteCodexAccount,
  getCodexAuthStatus,
  switchCodexAccount,
  type CodexStatusResult,
} from '@/api/hermes/codex-auth'
import CodexLoginModal from '@/components/hermes/models/CodexLoginModal.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const modelsStore = useModelsStore()
const message = useMessage()
const dialog = useDialog()

const savingKey = ref<string | null>(null)
const editKeys = ref<Record<string, string>>({})

const showCodexLogin = ref(false)
const codexStatusLoading = ref(false)
const codexActionLoading = ref(false)
const codexStatus = ref<CodexStatusResult>({ authenticated: false, accounts: [] })
const selectedCodexAccountId = ref<string | null>(null)

const isCustom = (provider: string) => {
  const g = modelsStore.providers.find(p => p.provider === provider)
  return !g?.builtin && provider.startsWith('custom:')
}

function getEditKey(provider: string): string {
  if (!(provider in editKeys.value)) {
    const g = modelsStore.providers.find(p => p.provider === provider)
    editKeys.value[provider] = g?.api_key || ''
  }
  return editKeys.value[provider]
}

async function refreshCodexStatus() {
  codexStatusLoading.value = true
  try {
    const result = await getCodexAuthStatus()
    codexStatus.value = result
    selectedCodexAccountId.value = result.active_account_id || result.accounts?.[0]?.id || null
  } catch (e: any) {
    message.error(e.message || t('models.codexStatusLoadFailed'))
  } finally {
    codexStatusLoading.value = false
  }
}

onMounted(async () => {
  if (modelsStore.providers.length === 0) {
    await modelsStore.fetchProviders()
  }
  await refreshCodexStatus()
})

async function handleSaveApiKey(providerKey: string) {
  const key = getEditKey(providerKey)
  if (!key.trim()) {
    message.warning(t('settings.models.apiKeyPlaceholder'))
    return
  }
  savingKey.value = providerKey
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    message.success(t('settings.models.saved'))
    await modelsStore.fetchProviders()
  } catch (e: any) {
    message.error(e.message || t('settings.models.saveFailed'))
  } finally {
    savingKey.value = null
  }
}

async function handleSaveCustom(providerKey: string) {
  const key = getEditKey(providerKey)
  savingKey.value = providerKey
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    message.success(t('settings.models.saved'))
    await modelsStore.fetchProviders()
  } catch (e: any) {
    message.error(e.message || t('settings.models.saveFailed'))
  } finally {
    savingKey.value = null
  }
}

async function handleCodexSwitch() {
  const credentialId = selectedCodexAccountId.value
  if (!credentialId) {
    message.warning(t('models.codexSelectAccount'))
    return
  }

  codexActionLoading.value = true
  try {
    await switchCodexAccount(credentialId, modelsStore.defaultModel || undefined)
    await Promise.all([refreshCodexStatus(), modelsStore.fetchProviders()])
    message.success(t('models.codexSwitchSuccess'))
  } catch (e: any) {
    message.error(e.message || t('models.codexSwitchFailed'))
  } finally {
    codexActionLoading.value = false
  }
}

function confirmDeleteCodexAccount() {
  const credentialId = selectedCodexAccountId.value
  if (!credentialId) {
    message.warning(t('models.codexSelectAccount'))
    return
  }

  const account = codexStatus.value.accounts.find(item => item.id === credentialId)
  dialog.warning({
    title: t('models.codexDeleteAccount'),
    content: t('models.codexDeleteConfirm', { name: account?.label || credentialId }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      codexActionLoading.value = true
      try {
        await deleteCodexAccount(credentialId)
        await Promise.all([refreshCodexStatus(), modelsStore.fetchProviders()])
        message.success(t('models.codexDeleteSuccess'))
      } catch (e: any) {
        message.error(e.message || t('models.codexDeleteFailed'))
      } finally {
        codexActionLoading.value = false
      }
    },
  })
}

async function handleCodexLoginSuccess() {
  showCodexLogin.value = false
  await Promise.all([refreshCodexStatus(), modelsStore.fetchProviders()])
  message.success(t('models.codexApproved'))
}
</script>

<template>
  <section class="settings-section">
    <NSpin :show="modelsStore.loading || codexStatusLoading">
      <div v-if="modelsStore.providers.length === 0" class="empty-hint">
        <NEmpty :description="t('settings.models.noProviders')" />
      </div>

      <div v-for="g in modelsStore.providers" :key="g.provider" class="provider-section">
        <div class="provider-header">
          <h4 class="provider-name">{{ g.label }}</h4>
          <span class="type-badge" :class="isCustom(g.provider) ? 'custom' : 'builtin'">
            {{ isCustom(g.provider) ? t('models.customType') : t('models.builtIn') }}
          </span>
        </div>

        <div v-if="isCodex(g.provider)" class="provider-fields codex-panel">
          <p class="codex-status-line">
            {{ codexStatus.authenticated ? t('models.codexLoggedIn') : t('models.codexNotLoggedIn') }}
          </p>

          <div class="field-row codex-actions-row">
            <NButton type="primary" size="small" @click="showCodexLogin = true">
              {{ codexStatus.accounts.length > 0 ? t('models.codexAddAccount') : t('models.codexLogin') }}
            </NButton>
          </div>

          <template v-if="codexStatus.accounts.length > 0">
            <div class="field-row">
              <NSelect
                v-model:value="selectedCodexAccountId"
                :options="codexAccountOptions"
                :placeholder="t('models.codexSelectAccount')"
              />
            </div>
            <div class="field-row codex-actions-row">
              <NButton
                size="small"
                :loading="codexActionLoading"
                @click="handleCodexSwitch"
              >
                {{ t('models.codexSwitchAccount') }}
              </NButton>
              <NButton
                size="small"
                type="error"
                ghost
                :loading="codexActionLoading"
                @click="confirmDeleteCodexAccount"
              >
                {{ t('models.codexDeleteAccount') }}
              </NButton>
            </div>
          </template>
        </div>

        <div v-else-if="!isCustom(g.provider)" class="provider-fields">
          <div class="field-row">
            <NInput
              :value="getEditKey(g.provider)"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.models.apiKeyPlaceholder')"
              autocomplete="off"
              @update:value="v => editKeys[g.provider] = v"
            />
            <NButton
              type="primary"
              size="small"
              :loading="savingKey === g.provider"
              @click="handleSaveApiKey(g.provider)"
            >
              {{ t('settings.models.save') }}
            </NButton>
          </div>
        </div>

        <div v-else class="provider-fields">
          <div class="field-row">
            <NInput
              :value="getEditKey(g.provider)"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.models.apiKeyPlaceholder')"
              autocomplete="off"
              @update:value="v => editKeys[g.provider] = v"
            />
            <NButton
              type="primary"
              size="small"
              :loading="savingKey === g.provider"
              @click="handleSaveCustom(g.provider)"
            >
              {{ t('settings.models.save') }}
            </NButton>
          </div>
        </div>
      </div>

      <div v-if="!codexProvider" class="provider-section codex-provider-fallback">
        <div class="provider-header">
          <h4 class="provider-name">OpenAI Codex</h4>
          <span class="type-badge builtin">{{ t('models.builtIn') }}</span>
        </div>
        <div class="provider-fields codex-panel">
          <p class="codex-status-line">{{ t('models.codexNotEnabledHint') }}</p>
          <NButton type="primary" size="small" @click="showCodexLogin = true">
            {{ t('models.codexLogin') }}
          </NButton>
        </div>
      </div>
    </NSpin>

    <CodexLoginModal
      v-if="showCodexLogin"
      :preferred-model="modelsStore.defaultModel || undefined"
      @close="showCodexLogin = false"
      @success="handleCodexLoginSuccess"
    />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.empty-hint {
  padding: 40px 0;
}

.provider-section {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  margin-bottom: 14px;
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.45);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin: 0;
}

.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;

  &.builtin {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.custom {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }
}

.provider-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 10px;

  .n-input,
  .n-select {
    flex: 1;
  }
}

.codex-panel {
  .codex-status-line {
    margin: 0;
    font-size: 12px;
    color: $text-muted;
  }
}

.codex-actions-row {
  justify-content: flex-start;
}

.codex-provider-fallback {
  border-style: dashed;
}
</style>
