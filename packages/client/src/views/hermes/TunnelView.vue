<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import {
  NCard,
  NButton,
  NSpace,
  NAlert,
  NSpin,
  useMessage,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import {
  getTunnelStatus,
  startTunnel,
  stopTunnel,
  getTunnelToken,
} from "@/api/hermes/tunnel";

const { t } = useI18n();
const message = useMessage();

const running = ref(false);
const url = ref<string | null>(null);
const token = ref("");
const cloudflaredInstalled = ref(false);
const installError = ref("");
const loading = ref(false);
const polling = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchStatus() {
  try {
    const s = await getTunnelStatus();
    running.value = s.running;
    url.value = s.url;
    cloudflaredInstalled.value = s.cloudflaredInstalled;
    installError.value = s.error || "";
  } catch (e: any) {
    console.error("Tunnel status error:", e);
  }
}

async function fetchToken() {
  try {
    const r = await getTunnelToken();
    token.value = r.token;
  } catch (e: any) {
    console.error("Tunnel token error:", e);
  }
}

function copyText(text: string, label: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  message.success(`${label} 已复制`);
}

function copyUrl() {
  if (url.value) copyText(url.value, "链接");
}

function copyToken() {
  if (token.value) copyText(token.value, "Token");
}

function copyFullUrl() {
  if (!url.value || !token.value) return;
  const sep = url.value.includes("?") ? "&" : "?";
  copyText(`${url.value}${sep}token=${token.value}`, "完整链接");
}

function startPolling() {
  if (pollTimer) return;
  polling.value = true;
  pollTimer = setInterval(async () => {
    await fetchStatus();
    if (running.value && url.value) {
      stopPolling();
    }
  }, 2000);
  // Timeout after 15s
  setTimeout(() => stopPolling(), 15000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  polling.value = false;
}

async function handleStart() {
  loading.value = true;
  try {
    const r = await startTunnel();
    if (r.success && r.url) {
      url.value = r.url;
      running.value = true;
      message.success("隧道已启动");
    } else if (r.success) {
      message.info("隧道启动中...");
      startPolling();
    } else {
      message.error(r.error || "启动失败");
    }
  } catch (e: any) {
    message.error(e.message || "启动失败");
  } finally {
    loading.value = false;
  }
}

async function handleStop() {
  loading.value = true;
  try {
    await stopTunnel();
    running.value = false;
    url.value = null;
    message.success("隧道已停止");
  } catch (e: any) {
    message.error(e.message || "停止失败");
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchStatus();
  fetchToken();
});

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <div class="tunnel-view">
    <header class="page-header">
      <h2 class="header-title">{{ t("sidebar.tunnel") }}</h2>
    </header>

    <div class="tunnel-content">
      <!-- Not installed -->
      <NCard v-if="!cloudflaredInstalled" class="tunnel-card">
        <NAlert type="error" :title="t('tunnel.notInstalled')">
          <p>{{ installError || t("tunnel.installHint") }}</p>
          <p class="install-cmd">
            curl -L
            https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
            -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared
          </p>
        </NAlert>
      </NCard>

      <!-- Main card -->
      <NCard v-else class="tunnel-card">
        <NSpin :show="loading || polling">
          <div class="tunnel-status">
            <div class="status-badge" :class="{ active: running }">
              <span class="dot"></span>
              <span>{{ running ? t("tunnel.running") : t("tunnel.stopped") }}</span>
            </div>
          </div>

          <!-- URL display -->
          <div v-if="url" class="url-section">
            <div class="url-row">
              <code class="url-value">{{ url }}</code>
              <NButton size="small" @click="copyUrl">
                {{ t("tunnel.copy") }}
              </NButton>
            </div>
            <div class="url-row">
              <code class="url-value url-full">{{ url }}{{ url.includes('?') ? '&' : '?' }}token={{ token }}</code>
              <NButton size="small" type="primary" @click="copyFullUrl">
                {{ t("tunnel.copyFull") }}
              </NButton>
            </div>
          </div>

          <!-- Actions -->
          <NSpace class="actions">
            <NButton
              v-if="!running"
              type="primary"
              :loading="loading || polling"
              @click="handleStart"
            >
              {{ t("tunnel.start") }}
            </NButton>
            <NButton
              v-else
              type="error"
              :loading="loading"
              @click="handleStop"
            >
              {{ t("tunnel.stop") }}
            </NButton>
          </NSpace>
        </NSpin>
      </NCard>

      <!-- Token card -->
      <NCard class="tunnel-card" :title="t('tunnel.tokenTitle')">
        <div class="url-row">
          <code class="url-value token-value">{{ token || '...' }}</code>
          <NButton size="small" @click="copyToken" :disabled="!token">
            {{ t("tunnel.copy") }}
          </NButton>
        </div>
      </NCard>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.tunnel-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.tunnel-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}

.tunnel-card {
  width: 100%;
}

.tunnel-status {
  margin-bottom: 16px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.06);

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: $error;
  }

  &.active .dot {
    background: $success;
    box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
  }
}

.url-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.url-value {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
  font-size: 12px;
  word-break: break-all;
  overflow-wrap: anywhere;
  line-height: 1.5;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }
}

.url-full {
  font-size: 11px;
}

.token-value {
  font-family: monospace;
}

.actions {
  margin-top: 8px;
}

.install-cmd {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
  line-height: 1.6;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }
}
</style>
