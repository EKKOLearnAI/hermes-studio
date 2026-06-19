<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey, getBaseUrlValue, setServerUrl, clearApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/auth";

const { t } = useI18n();
const router = useRouter();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);
const currentServerUrl = ref("");
const editUrl = ref("");
const showUrlEditor = ref(false);

// If already has a key, try to go to main page
if (hasApiKey()) {
  router.replace("/hermes/chat");
}

onMounted(async () => {
  currentServerUrl.value = getBaseUrlValue();
  editUrl.value = currentServerUrl.value;
  // Show URL editor if user has a custom URL set
  showUrlEditor.value = !!currentServerUrl.value;

  try {
    await fetchAuthStatus();
  } catch {
    // Login remains available; the submit request will surface connection errors.
  }
});

function handleApplyUrl() {
  const url = editUrl.value.trim().replace(/\/+$/, "");
  if (url === currentServerUrl.value) return;
  setServerUrl(url);
  clearApiKey();
  window.location.reload();
}

function handleClearUrl() {
  editUrl.value = "";
  setServerUrl("");
  clearApiKey();
  window.location.reload();
}

async function handleLogin() {
  await handlePasswordLogin();
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";
  showLockResetHint.value = false;

  try {
    const sessionToken = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(sessionToken);
    router.replace("/hermes/chat");
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
      showLockResetHint.value = true;
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>
      <p class="login-default-hint">{{ t("login.defaultCredentialsHint") }}</p>

      <!-- Server URL editor (always visible for custom URL, collapsible for same-origin) -->
      <div class="server-hint">{{ t('login.serverHint') }}</div>
      <div class="server-section">
        <div class="server-current" @click="showUrlEditor = !showUrlEditor">
          <span class="server-dot" :class="{ connected: !currentServerUrl }"></span>
          <span class="server-display">
            {{ currentServerUrl || t('settings.connection.same_origin') }}
          </span>
          <svg class="server-chevron" :class="{ open: showUrlEditor }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div v-if="showUrlEditor" class="server-editor">
          <input
            v-model="editUrl"
            type="text"
            class="login-input server-input"
            :placeholder="t('settings.connection.placeholder')"
            @keyup.enter="handleApplyUrl"
          />
          <div class="server-editor-btns">
            <button type="button" class="server-btn apply" @click="handleApplyUrl">
              {{ t('settings.connection.switch') }}
            </button>
            <button v-if="currentServerUrl" type="button" class="server-btn reset" @click="handleClearUrl">
              {{ t('settings.connection.reset') }}
            </button>
          </div>
        </div>
      </div>

      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="username"
          type="text"
          class="login-input"
          :placeholder="t('login.usernamePlaceholder')"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="login-input"
          :placeholder="t('login.passwordPlaceholder')"
          @keyup.enter="handleLogin"
        />

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <div v-if="showLockResetHint" class="login-lock-hint">
          <span>{{ t("login.lockResetHint") }}</span>
          <code>hermes-web-ui clear-login-locks --restart</code>
          <span>{{ t("login.defaultLoginResetHint") }}</span>
          <code>hermes-web-ui reset-default-login</code>
        </div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.login-logo {
  margin-bottom: 24px;
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 12px;
  line-height: 1.6;
}

.login-default-hint {
  margin: 0 0 20px;
  font-family: $font-code;
  font-size: 13px;
  color: $text-secondary;
}

.server-hint {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--n-text-color-3);
  line-height: 1.5;
  white-space: pre-line;
}

.server-section {
  margin-bottom: 20px;
  text-align: left;
}

.server-current {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: border-color $transition-fast;
  font-size: 12px;

  &:hover {
    border-color: $accent-primary;
  }
}

.server-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: $warning;
  flex-shrink: 0;

  &.connected {
    background: $success;
  }
}

.server-display {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-family: $font-code;
}

.server-chevron {
  flex-shrink: 0;
  transition: transform 0.2s;
  color: $text-muted;

  &.open {
    transform: rotate(180deg);
  }
}

.server-editor {
  margin-top: 8px;
}

.server-input {
  font-size: 13px !important;
  padding: 10px 12px !important;
}

.server-editor-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.server-btn {
  padding: 6px 14px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;

  &.apply {
    background: $text-primary;
    color: var(--text-on-accent);
    border-color: transparent;
  }

  &.reset {
    background: transparent;
    color: $text-secondary;

    &:hover {
      color: $error;
      border-color: rgba(var(--error-rgb), 0.3);
    }
  }
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: 13px;
  color: $error;
  text-align: left;
}

.login-lock-hint {
  padding: 10px 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.35);
  border-radius: $radius-sm;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;

  code {
    display: block;
    margin-top: 4px;
    color: $text-primary;
    font-family: $font-code;
    word-break: break-all;
  }
}

.login-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-forced;
  }
}
</style>
