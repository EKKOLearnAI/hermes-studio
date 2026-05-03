<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, useMessage } from 'naive-ui'
import {
  fetchTunnels,
  restartTunnel,
  startTunnel,
  stopTunnel,
  type TunnelStatus,
} from '@/api/hermes/tunnels'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const actionLoading = ref('')
const tunnel = ref<TunnelStatus | null>(null)
const targetUrl = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null

async function loadTunnel() {
  loading.value = true
  try {
    const tunnels = await fetchTunnels()
    tunnel.value = tunnels.frontend
    targetUrl.value = tunnels.frontend?.target_url || 'http://127.0.0.1:8650'
  } catch (error: any) {
    message.error(error?.message || t('tunnels.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function refreshOnly() {
  try {
    const tunnels = await fetchTunnels()
    tunnel.value = tunnels.frontend
  } catch {
    // silent during polling
  }
}

async function handleStart() {
  actionLoading.value = 'start'
  try {
    tunnel.value = await startTunnel('frontend', targetUrl.value || undefined)
    message.success(t('tunnels.startSuccess'))
    await refreshOnly()
  } catch (error: any) {
    message.error(error?.message || t('tunnels.startFailed'))
  } finally {
    actionLoading.value = ''
  }
}

async function handleStop() {
  actionLoading.value = 'stop'
  try {
    tunnel.value = await stopTunnel('frontend')
    message.success(t('tunnels.stopSuccess'))
  } catch (error: any) {
    message.error(error?.message || t('tunnels.stopFailed'))
  } finally {
    actionLoading.value = ''
  }
}

async function handleRestart() {
  actionLoading.value = 'restart'
  try {
    tunnel.value = await restartTunnel('frontend', targetUrl.value || undefined)
    message.success(t('tunnels.restartSuccess'))
    await refreshOnly()
  } catch (error: any) {
    message.error(error?.message || t('tunnels.restartFailed'))
  } finally {
    actionLoading.value = ''
  }
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    message.success(t('common.copied'))
  } catch {
    message.error(t('tunnels.copyFailed'))
  }
}

onMounted(async () => {
  await loadTunnel()
  pollTimer = setInterval(() => {
    void refreshOnly()
  }, 5000)
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="tunnels-view">
    <!-- Ambient background blobs -->
    <div class="ambient">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
    </div>

    <header class="page-header">
      <h2 class="header-title">{{ t('tunnels.title') }}</h2>
      <p class="header-subtitle">{{ t('tunnels.subtitle') }}</p>
    </header>

    <div class="tunnels-content" v-if="tunnel">
      <div class="glass-card">
        <!-- Shimmer border -->
        <div class="shimmer-border"></div>

        <div class="card-inner">
          <!-- Header -->
          <div class="card-header">
            <div class="card-header-left">
              <div class="card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12h6" />
                  <path d="M9 8l4 4-4 4" />
                </svg>
              </div>
              <div>
                <div class="card-title">{{ t('tunnels.quickTunnel') }}</div>
                <div class="card-desc">{{ t('tunnels.quickTunnelDesc') }}</div>
              </div>
            </div>
            <div class="status-badge" :class="{ active: tunnel.running }">
              <span class="status-dot"></span>
              {{ tunnel.running ? t('tunnels.running') : t('tunnels.stopped') }}
            </div>
          </div>

          <!-- Tip -->
          <div class="glass-tip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>{{ t('tunnels.tip') }}</span>
          </div>

          <!-- Target URL -->
          <div class="field-group">
            <label class="field-label">{{ t('tunnels.targetUrl') }}</label>
            <div class="glass-input-wrap">
              <NInput
                v-model:value="targetUrl"
                :disabled="tunnel.running"
                :placeholder="t('tunnels.targetPlaceholder')"
                :bordered="false"
              />
            </div>
          </div>

          <!-- Public URL -->
          <div class="field-group">
            <label class="field-label">{{ t('tunnels.publicUrl') }}</label>
            <div v-if="tunnel.public_url" class="public-url-box">
              <a :href="tunnel.public_url" target="_blank" rel="noopener noreferrer" class="url-link">
                {{ tunnel.public_url }}
              </a>
              <button class="copy-btn" @click="copyUrl(tunnel.public_url!)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {{ t('common.copy') }}
              </button>
            </div>
            <div v-else-if="tunnel.running" class="generating-box">
              <div class="wave-loader">
                <span></span><span></span><span></span><span></span><span></span>
              </div>
              <span class="generating-text">{{ t('tunnels.generating') }}</span>
            </div>
            <div v-else class="empty-url-box">
              {{ t('tunnels.noPublicUrl') }}
            </div>
          </div>

          <!-- Error -->
          <div v-if="tunnel.error" class="error-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            {{ tunnel.error }}
          </div>

          <!-- Actions -->
          <div class="actions">
            <button
              v-if="!tunnel.running"
              class="glass-btn primary"
              :class="{ loading: actionLoading === 'start' }"
              :disabled="!!actionLoading"
              @click="handleStart"
            >
              <span class="btn-shine"></span>
              <svg v-if="actionLoading !== 'start'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span v-if="actionLoading === 'start'" class="btn-spinner"></span>
              {{ t('common.start') }}
            </button>
            <button
              v-if="tunnel.running"
              class="glass-btn danger"
              :class="{ loading: actionLoading === 'stop' }"
              :disabled="!!actionLoading"
              @click="handleStop"
            >
              <span class="btn-shine"></span>
              <svg v-if="actionLoading !== 'stop'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              <span v-if="actionLoading === 'stop'" class="btn-spinner"></span>
              {{ t('common.stop') }}
            </button>
            <button
              class="glass-btn ghost"
              :class="{ loading: actionLoading === 'restart' }"
              :disabled="!!actionLoading"
              @click="handleRestart"
            >
              <span class="btn-shine"></span>
              <svg v-if="actionLoading !== 'restart'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span v-if="actionLoading === 'restart'" class="btn-spinner"></span>
              {{ t('tunnels.restart') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="loading-wrap">
      <div class="wave-loader"><span></span><span></span><span></span><span></span><span></span></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

/* ── Page ─────────────────────────────────────── */

.tunnels-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

/* ── Ambient blobs ────────────────────────────── */

.ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.35;
  animation: float 20s ease-in-out infinite;
}

.blob-1 {
  width: 300px;
  height: 300px;
  background: var(--accent-info, #6ba3d6);
  top: -80px;
  right: -60px;
  animation-delay: 0s;
}

.blob-2 {
  width: 250px;
  height: 250px;
  background: var(--success, #66bb6a);
  bottom: -40px;
  left: -60px;
  animation-delay: -7s;
}

.blob-3 {
  width: 200px;
  height: 200px;
  background: var(--accent-primary, #e0e0e0);
  top: 50%;
  left: 60%;
  animation-delay: -14s;
}

@keyframes float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(30px, -20px) scale(1.05); }
  66% { transform: translate(-20px, 15px) scale(0.95); }
}

/* ── Header ───────────────────────────────────── */

.page-header {
  position: relative;
  z-index: 1;
  padding: 24px 28px 0;
}

.header-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.header-subtitle {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-muted);
}

/* ── Content ──────────────────────────────────── */

.tunnels-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 32px;
  position: relative;
  z-index: 1;
}

/* ── Glass Card ───────────────────────────────── */

.glass-card {
  position: relative;
  max-width: 520px;
  border-radius: 16px;
  overflow: hidden;
}

.shimmer-border {
  position: absolute;
  inset: 0;
  border-radius: 16px;
  padding: 1px;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.25),
    rgba(255, 255, 255, 0.05),
    rgba(255, 255, 255, 0.15)
  );
  background-size: 300% 300%;
  animation: shimmer 8s ease-in-out infinite;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  z-index: 1;
}

@keyframes shimmer {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

.card-inner {
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.55);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  border-radius: 16px;
  padding: 24px;
}

.dark .card-inner {
  background: rgba(var(--bg-card-rgb, 51, 51, 51), 0.45);
}

/* ── Card Header ──────────────────────────────── */

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.card-header-left {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--accent-primary-rgb, 51, 51, 51), 0.08);
  color: var(--accent-primary);
  flex-shrink: 0;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.card-desc {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
}

/* ── Status Badge ─────────────────────────────── */

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(var(--text-muted-rgb, 153, 153, 153), 0.1);
  color: var(--text-muted);
  flex-shrink: 0;
  transition: all 0.4s ease;
}

.status-badge.active {
  background: rgba(var(--success-rgb, 46, 125, 50), 0.12);
  color: var(--success);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  transition: all 0.4s ease;
}

.status-badge.active .status-dot {
  box-shadow: 0 0 6px rgba(var(--success-rgb, 46, 125, 50), 0.6);
  animation: pulse-dot 2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Glass Tip ────────────────────────────────── */

.glass-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--accent-info);
  background: rgba(var(--accent-info-rgb, 74, 144, 217), 0.07);
  margin-bottom: 20px;
  line-height: 1.5;
  svg { flex-shrink: 0; opacity: 0.7; }
}

/* ── Fields ───────────────────────────────────── */

.field-group {
  margin-bottom: 18px;
}

.field-label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.glass-input-wrap {
  border-radius: 10px;
  background: rgba(var(--bg-input-rgb, 255, 255, 255), 0.5);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.3);
  transition: border-color 0.2s, box-shadow 0.2s;
  overflow: hidden;

  &:focus-within {
    border-color: rgba(var(--accent-primary-rgb, 51, 51, 51), 0.3);
    box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb, 51, 51, 51), 0.06);
  }

  :deep(.n-input) {
    --n-color: transparent !important;
    --n-color-disabled: transparent !important;
    --n-border: none !important;
    --n-border-hover: none !important;
    --n-border-focus: none !important;
    --n-box-shadow-focus: none !important;
    --n-caret-color: var(--accent-primary) !important;
    --n-text-color: var(--text-primary) !important;
    --n-text-color-disabled: var(--text-muted) !important;
    --n-placeholder-color: var(--text-muted) !important;
    --n-font-size: 13px !important;
    background: transparent !important;
  }
}

/* ── Public URL ───────────────────────────────── */

.public-url-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(var(--success-rgb, 46, 125, 50), 0.06);
  border: 1px solid rgba(var(--success-rgb, 46, 125, 50), 0.12);
}

.url-link {
  font-size: 13px;
  font-family: var(--font-code, monospace);
  color: var(--accent-info);
  word-break: break-all;
  text-decoration: none;
  transition: color 0.2s;

  &:hover {
    color: var(--accent-primary);
    text-decoration: underline;
  }
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.3);
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.5);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;

  &:hover {
    background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.8);
    color: var(--text-primary);
    border-color: rgba(var(--border-color-rgb, 224, 224, 224), 0.5);
  }
}

/* ── Generating animation ─────────────────────── */

.generating-box {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(var(--accent-info-rgb, 74, 144, 217), 0.05);
  border: 1px solid rgba(var(--accent-info-rgb, 74, 144, 217), 0.1);
}

.generating-text {
  font-size: 13px;
  color: var(--accent-info);
}

.wave-loader {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 16px;

  span {
    width: 3px;
    height: 8px;
    border-radius: 2px;
    background: var(--accent-info);
    animation: wave 1.2s ease-in-out infinite;

    &:nth-child(1) { animation-delay: 0s; }
    &:nth-child(2) { animation-delay: 0.1s; }
    &:nth-child(3) { animation-delay: 0.2s; }
    &:nth-child(4) { animation-delay: 0.3s; }
    &:nth-child(5) { animation-delay: 0.4s; }
  }
}

@keyframes wave {
  0%, 60%, 100% { height: 6px; opacity: 0.4; }
  30% { height: 16px; opacity: 1; }
}

/* ── Empty URL ────────────────────────────────── */

.empty-url-box {
  font-size: 12px;
  color: var(--text-muted);
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(var(--text-muted-rgb, 153, 153, 153), 0.04);
  border: 1px dashed rgba(var(--border-color-rgb, 224, 224, 224), 0.3);
}

/* ── Error ────────────────────────────────────── */

.error-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--error);
  background: rgba(var(--error-rgb, 198, 40, 40), 0.06);
  border: 1px solid rgba(var(--error-rgb, 198, 40, 40), 0.1);
  margin-bottom: 16px;
  line-height: 1.5;
  svg { flex-shrink: 0; margin-top: 1px; }
}

/* ── Action Buttons ───────────────────────────── */

.actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.glass-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 20px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.25s ease;
  border: none;
  outline: none;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.glass-btn.primary {
  background: rgba(var(--accent-primary-rgb, 51, 51, 51), 0.85);
  color: var(--text-on-accent);
  backdrop-filter: blur(8px);

  &:hover:not(:disabled) {
    background: rgba(var(--accent-primary-rgb, 51, 51, 51), 0.95);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(var(--accent-primary-rgb, 51, 51, 51), 0.25);
  }
}

.glass-btn.danger {
  background: rgba(var(--error-rgb, 198, 40, 40), 0.85);
  color: #fff;
  backdrop-filter: blur(8px);

  &:hover:not(:disabled) {
    background: rgba(var(--error-rgb, 198, 40, 40), 0.95);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(var(--error-rgb, 198, 40, 40), 0.25);
  }
}

.glass-btn.ghost {
  background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.4);
  color: var(--text-secondary);
  border: 1px solid rgba(var(--border-color-rgb, 224, 224, 224), 0.3);
  backdrop-filter: blur(8px);

  &:hover:not(:disabled) {
    background: rgba(var(--bg-card-rgb, 255, 255, 255), 0.6);
    color: var(--text-primary);
    border-color: rgba(var(--border-color-rgb, 224, 224, 224), 0.5);
    transform: translateY(-1px);
  }
}

/* Button shine effect */
.btn-shine {
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.15), transparent);
  transition: left 0.5s ease;
  pointer-events: none;
}

.glass-btn:hover:not(:disabled) .btn-shine {
  left: 100%;
}

/* Button spinner */
.btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.glass-btn.ghost .btn-spinner {
  border-color: rgba(var(--text-muted-rgb, 153, 153, 153), 0.3);
  border-top-color: currentColor;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Loading ──────────────────────────────────── */

.loading-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
}
</style>
