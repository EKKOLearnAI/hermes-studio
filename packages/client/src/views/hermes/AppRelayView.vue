<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NCard, NInput, NPopconfirm, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import {
  connectAppRelay,
  disconnectAppRelay,
  fetchAppRelayBootstrap,
  refreshAppRelayPairingCode,
  type AppRelayStatus,
} from '@/api/hermes/app-relay'
import {
  fetchAppAuthConfig,
  loginAppAccount,
  logoutAppAccount,
  registerAppAccount,
  restoreAppAccount,
  sendAppRegistrationCode,
  type AppAccountUser,
} from '@/api/hermes/app-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t, te } = useI18n()
const router = useRouter()
const message = useMessage()

const relay = ref<AppRelayStatus>({
  connected: false,
  machineId: '',
  pairingCode: '',
  pairingExpiresAt: 0,
})
const loading = ref(false)
const action = ref<'connect' | 'pairing' | 'disconnect' | ''>('')
const authAction = ref<'login' | 'register' | 'email-code' | 'logout' | ''>('')
const authMode = ref<'login' | 'register'>('login')
const authReady = ref(false)
const appAuthBaseUrl = ref('')
const appAccount = ref<AppAccountUser | null>(null)
const authEmail = ref('')
const authPassword = ref('')
const authDisplayName = ref('')
const authVerificationCode = ref('')
const emailVerificationEnabled = ref(false)
const emailCodeCooldownUntil = ref(0)
const authConfigReady = ref(false)
const now = ref(Date.now())
const disableLocalAuthAutofill = typeof window !== 'undefined' && [
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
].includes(window.location.hostname)
const showSidebar = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
let clock: number | null = null
let mobileQuery: MediaQueryList | null = null

const pairingExpiresAtMs = computed(() => Number(relay.value.pairingExpiresAt || relay.value.expiresAt || 0) * 1000)
const pairingActive = computed(() =>
  relay.value.connected &&
  Boolean(relay.value.pairingCode) &&
  pairingExpiresAtMs.value > now.value,
)
const pairingRemaining = computed(() => {
  const seconds = Math.max(0, Math.ceil((pairingExpiresAtMs.value - now.value) / 1000))
  return {
    minutes: String(Math.floor(seconds / 60)).padStart(2, '0'),
    seconds: String(seconds % 60).padStart(2, '0'),
  }
})
const emailCodeRemaining = computed(() =>
  Math.max(0, Math.ceil((emailCodeCooldownUntil.value - now.value) / 1000)),
)
const ignoredPasswordManagerProps = {
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-lpignore': 'true',
}
const emailInputProps = computed(() => disableLocalAuthAutofill
  ? { autocomplete: 'off', ...ignoredPasswordManagerProps }
  : { autocomplete: 'email' })
const passwordInputProps = computed(() => disableLocalAuthAutofill
  ? { autocomplete: 'new-password', ...ignoredPasswordManagerProps }
  : { autocomplete: authMode.value === 'register' ? 'new-password' : 'current-password' })

function openChat() {
  void router.push({ name: 'hermes.chat' })
}

function openPageSidebar() {
  showSidebar.value = true
}

function handleMobileChange(event: MediaQueryList | MediaQueryListEvent) {
  showSidebar.value = !event.matches
}

async function loadStatus(showError = true) {
  loading.value = true
  try {
    const bootstrap = await fetchAppRelayBootstrap()
    relay.value = bootstrap.relay
    appAuthBaseUrl.value = bootstrap.appAuthBaseUrl
  } catch (error: any) {
    if (showError) message.error(error?.message || t('appRelay.loadFailed'))
  } finally {
    loading.value = false
  }
}

function appAuthError(error: unknown, fallbackKey: string): string {
  const code = error instanceof Error ? error.message : String(error || '')
  const key = `appRelay.authErrors.${code}`
  return code && te(key) ? t(key) : t(fallbackKey)
}

async function initializePage() {
  loading.value = true
  try {
    const bootstrap = await fetchAppRelayBootstrap()
    relay.value = bootstrap.relay
    appAuthBaseUrl.value = bootstrap.appAuthBaseUrl
    const session = await restoreAppAccount(appAuthBaseUrl.value)
    appAccount.value = session?.user || null
    const authConfig = await fetchAppAuthConfig(appAuthBaseUrl.value)
    emailVerificationEnabled.value = authConfig.emailVerificationEnabled
  } catch (error) {
    message.error(appAuthError(error, 'appRelay.loadFailed'))
  } finally {
    authConfigReady.value = true
    authReady.value = true
    loading.value = false
  }
}

async function submitAppAuth() {
  if (!appAuthBaseUrl.value) {
    message.error(t('appRelay.authUnavailable'))
    return
  }
  const email = authEmail.value.trim()
  const password = authPassword.value
  if (!email || !password) {
    message.error(t('appRelay.authRequired'))
    return
  }
  if (authMode.value === 'register' && password.length < 8) {
    message.error(t('appRelay.passwordHint'))
    return
  }
  if (authMode.value === 'register' && !/^\d{6}$/.test(authVerificationCode.value.trim())) {
    message.error(t('appRelay.verificationCodeRequired'))
    return
  }

  authAction.value = authMode.value
  try {
    const session = authMode.value === 'register'
      ? await registerAppAccount(appAuthBaseUrl.value, {
          email,
          password,
          verificationCode: authVerificationCode.value.trim(),
          displayName: authDisplayName.value.trim() || undefined,
        })
      : await loginAppAccount(appAuthBaseUrl.value, { email, password })
    appAccount.value = session.user
    authPassword.value = ''
    authVerificationCode.value = ''
    message.success(t(authMode.value === 'register' ? 'appRelay.registerSuccess' : 'appRelay.loginSuccess'))
  } catch (error) {
    message.error(appAuthError(error, authMode.value === 'register' ? 'appRelay.registerFailed' : 'appRelay.loginFailed'))
  } finally {
    authAction.value = ''
  }
}

async function handleSendEmailCode() {
  if (!appAuthBaseUrl.value) {
    message.error(t('appRelay.authUnavailable'))
    return
  }
  const email = authEmail.value.trim()
  if (!email) {
    message.error(t('appRelay.emailRequired'))
    return
  }
  authAction.value = 'email-code'
  try {
    const result = await sendAppRegistrationCode(appAuthBaseUrl.value, email)
    emailCodeCooldownUntil.value = Date.now() + Math.max(1, result.retryAfter) * 1000
    message.success(t('appRelay.verificationCodeSent'))
  } catch (error) {
    message.error(appAuthError(error, 'appRelay.verificationCodeFailed'))
  } finally {
    authAction.value = ''
  }
}

async function handleAppLogout() {
  authAction.value = 'logout'
  try {
    await logoutAppAccount(appAuthBaseUrl.value)
    appAccount.value = null
    authPassword.value = ''
    message.success(t('appRelay.logoutSuccess'))
  } catch (error) {
    message.error(appAuthError(error, 'appRelay.logoutFailed'))
  } finally {
    authAction.value = ''
  }
}

async function handleConnect() {
  action.value = 'connect'
  try {
    relay.value = await connectAppRelay()
    message.success(t('appRelay.connectedMessage'))
  } catch (error: any) {
    message.error(error?.message || t('appRelay.connectFailed'))
  } finally {
    action.value = ''
  }
}

async function handleRefreshPairing() {
  action.value = 'pairing'
  try {
    relay.value = await refreshAppRelayPairingCode()
    message.success(t('appRelay.pairingRefreshed'))
  } catch (error: any) {
    message.error(error?.message || t('appRelay.pairingFailed'))
  } finally {
    action.value = ''
  }
}

async function handleDisconnect() {
  action.value = 'disconnect'
  try {
    relay.value = await disconnectAppRelay()
    message.success(t('appRelay.disconnectedMessage'))
  } catch (error: any) {
    message.error(error?.message || t('appRelay.disconnectFailed'))
  } finally {
    action.value = ''
  }
}

async function copyPairingCode() {
  if (!pairingActive.value) return
  const copied = await copyToClipboard(relay.value.pairingCode)
  message[copied ? 'success' : 'error'](t(copied ? 'appRelay.copied' : 'appRelay.copyFailed'))
}

onMounted(() => {
  clock = window.setInterval(() => { now.value = Date.now() }, 1000)
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
  void initializePage()
})

onUnmounted(() => {
  if (clock !== null) window.clearInterval(clock)
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
})
</script>

<template>
  <div class="app-relay-view">
    <div class="app-relay-sidebar-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
    <aside class="app-relay-sidebar" :class="{ collapsed: !showSidebar }">
      <div v-if="showSidebar" class="page-sidebar-top">
        <PageSidebarNav active="app" @primary="openChat" />
      </div>
      <div v-if="showSidebar" class="sidebar-copy">
        <strong>{{ t('appRelay.title') }}</strong>
        <span>{{ t('appRelay.sidebarDescription') }}</span>
      </div>
      <PageSidebarFooter v-if="showSidebar" />
    </aside>

    <section class="app-relay-main" :class="{ 'app-relay-main--sidebar-collapsed': !showSidebar }">
      <header class="page-header">
        <h2 class="header-title">{{ t('appRelay.title') }}</h2>
        <div v-if="appAccount" class="header-actions account-actions">
          <div class="account-identity">
            <span>{{ t('appRelay.loggedInAs') }}</span>
            <strong>{{ appAccount.email }}</strong>
          </div>
          <NButton secondary :loading="loading" @click="loadStatus()">
            {{ t('appRelay.refreshStatus') }}
          </NButton>
          <NButton quaternary :loading="authAction === 'logout'" @click="handleAppLogout">
            {{ t('appRelay.logout') }}
          </NButton>
        </div>
      </header>

      <div
        class="relay-body"
        :class="{ 'relay-body--auth': authReady && !appAccount }"
      >
        <NSpin class="relay-spin" :show="loading">
          <div class="relay-content">
          <NCard v-if="authReady && !appAccount" class="auth-card" :bordered="false">
            <div class="auth-heading">
              <span class="eyebrow">{{ t('appRelay.accountTitle') }}</span>
              <h3>{{ t(authMode === 'register' ? 'appRelay.register' : 'appRelay.login') }}</h3>
              <p>{{ t('appRelay.accountDescription') }}</p>
            </div>

            <div class="auth-mode-switch">
              <button
                type="button"
                :class="{ active: authMode === 'login' }"
                @click="authMode = 'login'"
              >
                {{ t('appRelay.login') }}
              </button>
              <button
                type="button"
                :class="{ active: authMode === 'register' }"
                @click="authMode = 'register'"
              >
                {{ t('appRelay.register') }}
              </button>
            </div>

            <div class="auth-form">
              <label>
                <span>{{ t('appRelay.email') }}</span>
                <NInput
                  v-model:value="authEmail"
                  type="text"
                  :input-props="emailInputProps"
                  :placeholder="t('appRelay.emailPlaceholder')"
                  @keyup.enter="submitAppAuth"
                />
              </label>
              <label v-if="authMode === 'register'">
                <span>{{ t('appRelay.displayName') }}</span>
                <NInput
                  v-model:value="authDisplayName"
                  type="text"
                  autocomplete="name"
                  :placeholder="t('appRelay.displayNamePlaceholder')"
                />
              </label>
              <label v-if="authMode === 'register'">
                <span>{{ t('appRelay.verificationCode') }}</span>
                <div class="verification-row">
                  <NInput
                    v-model:value="authVerificationCode"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="6"
                    :placeholder="t('appRelay.verificationCodePlaceholder')"
                    @keyup.enter="submitAppAuth"
                  />
                  <NButton
                    secondary
                    :loading="authAction === 'email-code'"
                    :disabled="Boolean(authAction) || emailCodeRemaining > 0 || !emailVerificationEnabled"
                    @click="handleSendEmailCode"
                  >
                    {{ emailCodeRemaining > 0
                      ? t('appRelay.resendIn', { seconds: emailCodeRemaining })
                      : t('appRelay.sendVerificationCode') }}
                  </NButton>
                </div>
                <small v-if="authConfigReady && !emailVerificationEnabled" class="auth-warning">
                  {{ t('appRelay.emailVerificationUnavailable') }}
                </small>
              </label>
              <label>
                <span>{{ t('appRelay.password') }}</span>
                <NInput
                  v-model:value="authPassword"
                  type="password"
                  show-password-on="click"
                  :input-props="passwordInputProps"
                  :placeholder="t('appRelay.passwordPlaceholder')"
                  @keyup.enter="submitAppAuth"
                />
                <small v-if="authMode === 'register'">{{ t('appRelay.passwordHint') }}</small>
              </label>
              <NButton
                type="primary"
                block
                :loading="authAction === authMode"
                :disabled="Boolean(authAction)"
                @click="submitAppAuth"
              >
                {{ t(authMode === 'register' ? 'appRelay.createAccount' : 'appRelay.login') }}
              </NButton>

            </div>
          </NCard>

          <template v-else-if="appAccount">
            <NCard class="status-card" :bordered="false">
            <div class="status-heading">
              <div>
                <span class="eyebrow">{{ t('appRelay.status') }}</span>
                <div class="status-line">
                  <span class="status-dot" :class="{ connected: relay.connected }" />
                  <strong>{{ t(relay.connected ? 'appRelay.connected' : 'appRelay.disconnected') }}</strong>
                </div>
              </div>
              <NTag :type="relay.connected ? 'success' : 'default'" round>
                {{ t(relay.connected ? 'appRelay.connected' : 'appRelay.disconnected') }}
              </NTag>
            </div>

            <div class="machine-row">
              <span>{{ t('appRelay.machineId') }}</span>
              <code>{{ relay.machineId || '—' }}</code>
            </div>

            <div class="status-actions">
              <NButton
                v-if="!relay.connected"
                type="primary"
                :loading="action === 'connect'"
                :disabled="Boolean(action)"
                @click="handleConnect"
              >
                {{ t('appRelay.connect') }}
              </NButton>
              <template v-else>
                <NButton
                  type="primary"
                  :loading="action === 'pairing'"
                  :disabled="Boolean(action)"
                  @click="handleRefreshPairing"
                >
                  {{ t('appRelay.refreshPairing') }}
                </NButton>
                <NPopconfirm @positive-click="handleDisconnect">
                  <template #trigger>
                    <NButton type="error" secondary :loading="action === 'disconnect'" :disabled="Boolean(action)">
                      {{ t('appRelay.disconnect') }}
                    </NButton>
                  </template>
                  {{ t('appRelay.disconnectConfirm') }}
                </NPopconfirm>
              </template>
            </div>
            </NCard>

            <NCard v-if="relay.connected" class="pairing-card" :bordered="false">
            <span class="eyebrow">{{ t('appRelay.pairingTitle') }}</span>
            <p>{{ t('appRelay.pairingDescription') }}</p>
            <button
              class="pairing-code"
              :class="{ expired: !pairingActive }"
              type="button"
              :disabled="!pairingActive"
              @click="copyPairingCode"
            >
              {{ pairingActive ? relay.pairingCode : t('appRelay.noPairingCode') }}
            </button>
            <span class="pairing-expiry">
              {{ pairingActive
                ? t('appRelay.expiresIn', pairingRemaining)
                : t('appRelay.expired') }}
            </span>
            </NCard>

            <div class="independent-note">
            <div class="note-icon" aria-hidden="true">APP</div>
            <div>
              <strong>{{ t('appRelay.independentTitle') }}</strong>
              <p>{{ t('appRelay.independentDescription') }}</p>
              <small>{{ t('appRelay.localAuth') }}</small>
            </div>
            </div>
          </template>
          </div>
        </NSpin>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-relay-view {
  height: calc(100 * var(--vh));
  display: flex;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background: $bg-card;
}

.app-relay-sidebar {
  width: $sidebar-width;
  min-height: 0;
  margin: 10px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  background: $bg-sidebar-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  transition: width $transition-normal, opacity $transition-normal;

  &.collapsed {
    width: 0;
    margin-left: 0;
    margin-right: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }
}

.page-sidebar-top {
  padding: 12px;
  border-bottom: 1px solid $border-color;
}

.sidebar-copy {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px;
  color: $text-secondary;

  strong { color: $text-primary; }
  span { font-size: 12px; line-height: 1.6; }
}

.app-relay-main {
  flex: 1;
  min-width: 0;
  margin: 10px 10px 10px 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: $bg-main-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);

  &--sidebar-collapsed { margin-left: 10px; }
}

.relay-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;

  &--auth {
    justify-content: center;
    justify-content: safe center;
  }
}

.relay-spin {
  flex: 0 0 auto;
  width: 100%;
}

.account-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.account-identity {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  color: $text-muted;
  font-size: 11px;

  strong {
    max-width: 220px;
    overflow: hidden;
    color: $text-primary;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.relay-content {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 32px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.auth-card,
.status-card,
.pairing-card {
  background: $bg-secondary;
  border: 1px solid $border-color;
  border-radius: 14px;
}

.auth-heading {
  text-align: center;

  h3 { margin: 0; color: $text-primary; font-size: 22px; }
  p { margin: 8px auto 0; max-width: 520px; color: $text-secondary; line-height: 1.55; }
}

.auth-mode-switch {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
  margin: 24px auto 18px;
  padding: 4px;
  max-width: 360px;
  border-radius: 10px;
  background: $bg-primary;

  button {
    padding: 9px 14px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: $text-secondary;
    cursor: pointer;

    &.active {
      background: $bg-card;
      color: $text-primary;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
  }
}

.auth-form {
  max-width: 420px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 15px;

  label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    color: $text-secondary;
    font-size: 13px;
  }

  small { color: $text-muted; }
  .auth-warning { color: #d97706; }
}

.verification-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.status-heading,
.status-line,
.machine-row,
.status-actions {
  display: flex;
  align-items: center;
}

.status-heading {
  justify-content: space-between;
  gap: 16px;
}

.eyebrow {
  display: block;
  margin-bottom: 8px;
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.status-line { gap: 9px; font-size: 18px; }
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: $text-muted;
  box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.14);

  &.connected {
    background: #22c55e;
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14);
  }
}

.machine-row {
  justify-content: space-between;
  gap: 16px;
  margin-top: 24px;
  padding: 12px 14px;
  background: $bg-primary;
  border-radius: 9px;
  color: $text-secondary;

  code {
    min-width: 0;
    overflow-wrap: anywhere;
    color: $text-primary;
  }
}

.status-actions {
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.pairing-card p {
  margin: 0 0 20px;
  color: $text-secondary;
  line-height: 1.6;
}

.pairing-code {
  width: 100%;
  padding: 20px;
  border: 1px dashed var(--accent-primary);
  border-radius: 12px;
  background: rgba(var(--accent-primary-rgb), 0.07);
  color: var(--accent-primary);
  font: 700 32px/1.2 $font-code;
  letter-spacing: 0.18em;
  cursor: pointer;

  &.expired {
    border-color: $border-color;
    color: $text-muted;
    letter-spacing: 0;
    cursor: default;
  }
}

.pairing-expiry {
  display: block;
  margin-top: 10px;
  color: $text-muted;
  font-size: 12px;
  text-align: center;
}

.independent-note {
  display: flex;
  gap: 14px;
  padding: 18px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.18);
  border-radius: 12px;
  background: rgba(var(--accent-primary-rgb), 0.05);

  p { margin: 5px 0; color: $text-secondary; line-height: 1.55; }
  small { color: $text-muted; }
}

.note-icon {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--accent-primary);
  color: white;
  font-size: 11px;
  font-weight: 800;
}

.app-relay-sidebar-backdrop { display: none; }

@media (max-width: $breakpoint-mobile) {
  .app-relay-main {
    margin: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .app-relay-sidebar {
    position: absolute;
    z-index: 120;
    inset: 10px auto 10px 10px;
    height: auto;
    margin: 0;

    &.collapsed {
      width: $sidebar-width;
      transform: translateX(calc(-100% - 10px));
    }
  }

  .app-relay-sidebar-backdrop {
    display: block;
    position: absolute;
    z-index: 110;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    opacity: 0;
    pointer-events: none;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .account-actions { width: 100%; flex-wrap: wrap; }
  .account-identity { width: 100%; align-items: flex-start; }
  .relay-content { padding: 20px 14px; }
  .verification-row { grid-template-columns: 1fr; }
  .machine-row { align-items: flex-start; flex-direction: column; }
  .status-actions { align-items: stretch; flex-direction: column; }
}
</style>
