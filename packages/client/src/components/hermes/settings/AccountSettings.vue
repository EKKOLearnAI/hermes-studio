<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NButton, NInput, NModal, NForm, NFormItem, NPopconfirm, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import { fetchAuthStatus, setupPassword, changePassword, changeUsername, removePassword } from "@/api/auth";

const { t } = useI18n();
const message = useMessage();

const hasPasswordLogin = ref(false);
const username = ref<string | null>(null);
const loading = ref(false);

// Setup form
const showSetupModal = ref(false);
const setupUsername = ref("");
const setupPasswordVal = ref("");
const setupPasswordConfirm = ref("");

// Change password form
const showChangePasswordModal = ref(false);
const currentPasswordForPwd = ref("");
const newPasswordVal = ref("");
const newPasswordConfirm = ref("");

// Change username form
const showChangeUsernameModal = ref(false);
const currentPasswordForName = ref("");
const newUsernameVal = ref("");

onMounted(async () => {
  try {
    const status = await fetchAuthStatus();
    hasPasswordLogin.value = status.hasPasswordLogin;
    username.value = status.username;
  } catch { /* ignore */ }
});

async function handleSetup() {
  if (setupPasswordVal.value !== setupPasswordConfirm.value) {
    message.error(t("login.passwordMismatch"));
    return;
  }
  if (setupPasswordVal.value.length < 6) {
    message.error(t("login.passwordTooShort"));
    return;
  }
  loading.value = true;
  try {
    await setupPassword(setupUsername.value, setupPasswordVal.value);
    hasPasswordLogin.value = true;
    username.value = setupUsername.value;
    showSetupModal.value = false;
    setupUsername.value = "";
    setupPasswordVal.value = "";
    setupPasswordConfirm.value = "";
    message.success(t("login.setupSuccess"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

async function handleChangePassword() {
  if (newPasswordVal.value !== newPasswordConfirm.value) {
    message.error(t("login.passwordMismatch"));
    return;
  }
  if (newPasswordVal.value.length < 6) {
    message.error(t("login.passwordTooShort"));
    return;
  }
  loading.value = true;
  try {
    await changePassword(currentPasswordForPwd.value, newPasswordVal.value);
    showChangePasswordModal.value = false;
    currentPasswordForPwd.value = "";
    newPasswordVal.value = "";
    newPasswordConfirm.value = "";
    message.success(t("login.passwordChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

async function handleChangeUsername() {
  if (newUsernameVal.value.trim().length < 2) {
    message.error(t("login.usernameTooShort"));
    return;
  }
  loading.value = true;
  try {
    await changeUsername(currentPasswordForName.value, newUsernameVal.value.trim());
    username.value = newUsernameVal.value.trim();
    showChangeUsernameModal.value = false;
    currentPasswordForName.value = "";
    newUsernameVal.value = "";
    message.success(t("login.usernameChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

async function handleRemove() {
  loading.value = true;
  try {
    await removePassword();
    hasPasswordLogin.value = false;
    username.value = null;
    message.success(t("login.passwordRemoved"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

function openSetupModal() {
  setupUsername.value = "";
  setupPasswordVal.value = "";
  setupPasswordConfirm.value = "";
  showSetupModal.value = true;
}

function openChangePasswordModal() {
  currentPasswordForPwd.value = "";
  newPasswordVal.value = "";
  newPasswordConfirm.value = "";
  showChangePasswordModal.value = true;
}

function openChangeUsernameModal() {
  currentPasswordForName.value = "";
  newUsernameVal.value = "";
  showChangeUsernameModal.value = true;
}
</script>

<template>
  <div class="account-settings">
    <p class="section-desc">{{ t("login.setupDescription") }}</p>

    <!-- Not configured -->
    <div v-if="!hasPasswordLogin" class="action-row">
      <span class="action-label">{{ t("login.passwordLoginNotConfigured") }}</span>
      <NButton type="primary" @click="openSetupModal">{{ t("login.setupPassword") }}</NButton>
    </div>

    <!-- Configured -->
    <div v-else class="configured-section">
      <div class="action-row">
        <span class="action-label">{{ t("login.passwordLoginConfigured", { username }) }}</span>
        <div class="action-buttons">
          <NButton @click="openChangePasswordModal">{{ t("login.changePassword") }}</NButton>
          <NButton @click="openChangeUsernameModal">{{ t("login.changeUsername") }}</NButton>
          <NPopconfirm @positive-click="handleRemove">
            <template #trigger>
              <NButton type="error" ghost :loading="loading">{{ t("login.removePasswordLogin") }}</NButton>
            </template>
            {{ t("login.removeConfirm") }}
          </NPopconfirm>
        </div>
      </div>
    </div>

    <!-- Setup modal -->
    <NModal v-model:show="showSetupModal" preset="dialog" :title="t('login.setupPassword')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.username')">
          <NInput v-model:value="setupUsername" :placeholder="t('login.usernamePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="setupPasswordVal" type="password" show-password-on="click" :placeholder="t('login.passwordPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="setupPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleSetup" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showSetupModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSetup">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Change password modal -->
    <NModal v-model:show="showChangePasswordModal" preset="dialog" :title="t('login.changePassword')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForPwd" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="newPasswordVal" type="password" show-password-on="click" :placeholder="t('login.newPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="newPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleChangePassword" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangePasswordModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangePassword">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Change username modal -->
    <NModal v-model:show="showChangeUsernameModal" preset="dialog" :title="t('login.changeUsername')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForName" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newUsername')">
          <NInput v-model:value="newUsernameVal" :placeholder="t('login.usernamePlaceholder')" @keyup.enter="handleChangeUsername" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangeUsernameModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangeUsername">{{ t("common.save") }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.account-settings {
  padding: 8px 0;
}

.section-desc {
  font-size: 13px;
  color: $text-muted;
  margin: 0 0 20px;
  line-height: 1.6;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.action-label {
  font-size: 14px;
  color: $text-secondary;
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>
