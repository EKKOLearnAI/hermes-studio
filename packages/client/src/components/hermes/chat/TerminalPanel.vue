<script setup lang="ts">
import { ref, onUnmounted, computed, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import { NButton, NPopconfirm, NTooltip, NSelect, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import type { ITheme } from "@xterm/xterm";

const { t } = useI18n();
const message = useMessage();

const props = defineProps<{ visible?: boolean }>();

// ─── Terminal themes ────────────────────────────────────────────

const TERMINAL_THEMES: Record<string, { label: string; theme: ITheme }> = {
  default: {
    label: "Default",
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#4cc9f0",
      cursorAccent: "#1a1a2e",
      selectionBackground: "rgba(76, 201, 240, 0.3)",
      black: "#000000", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496",
      cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.3)",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  "tokyo-night": {
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#a9b1d6",
      cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "rgba(192, 202, 245, 0.2)",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  "github-dark": {
    label: "GitHub Dark",
    theme: {
      background: "#0d1117", foreground: "#c9d1d9",
      cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "rgba(88, 166, 255, 0.25)",
      black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#ffa657",
      blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#a5d6ff", white: "#c9d1d9",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#58a6ff", brightMagenta: "#bc8cff",
      brightCyan: "#79c0ff", brightWhite: "#f0f6fc",
    },
  },
};

const STORAGE_KEY_THEME = "hermes_terminal_theme";

// ─── Types ──────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  shell: string;
  pid: number;
  title: string;
  createdAt: number;
  exited: boolean;
}

// ─── State ──────────────────────────────────────────────────────

const terminalRef = ref<HTMLDivElement | null>(null);
const sessions = ref<SessionInfo[]>([]);
const activeSessionId = ref<string | null>(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");
const connectionError = ref<string | null>(null);
const isConnecting = ref(false);
const showSidebar = ref(false);

let ws: WebSocket | null = null;
const termMap = new Map<string, { term: Terminal; fitAddon: FitAddon; opened: boolean }>();
let activeTerm: Terminal | null = null;
let activeFitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// ─── Computed ──────────────────────────────────────────────────

const activeSession = computed(
  () => sessions.value.find((s) => s.id === activeSessionId.value) || null,
);

const themeOptions = computed(() =>
  Object.entries(TERMINAL_THEMES).map(([key, val]) => ({
    label: val.label,
    value: key,
  })),
);

const terminalBg = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e",
);

// ─── WebSocket ──────────────────────────────────────────────────

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return `${hostname}:${port}`;
  }
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function buildWsUrl(): string {
  const token = getApiKey();
  const base = getBaseUrlValue();
  const wsProtocol = base
    ? base.startsWith("https")
      ? "wss:"
      : "ws:"
    : location.protocol === "https:"
      ? "wss:"
      : "ws:";

  if (base) {
    return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  const host = import.meta.env.DEV
    ? formatHostForPort(location.hostname, 8648)
    : location.host;
  return `${wsProtocol}//${host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

function connect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionError.value = t('terminal.connectionFailed');
    isConnecting.value = false;
    return;
  }

  const url = buildWsUrl();
  connectionError.value = null;
  isConnecting.value = true;
  reconnectAttempts++;

  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnecting.value = false;
    connectionError.value = null;
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (data.charCodeAt(0) === 0x7b) {
      try {
        handleControl(JSON.parse(data));
      } catch {}
    } else {
      activeTerm?.write(data);
    }
  };

  ws.onclose = (event) => {
    isConnecting.value = false;

    // 如果是正常关闭（code 1000）或认证失败，不重连
    if (event.code === 1000 || event.code === 1003 || event.code === 1008) {
      connectionError.value = t('terminal.connectionClosed');
      return;
    }

    // 其他情况尝试重连
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('[Terminal] WebSocket error:', error);
    connectionError.value = t('terminal.connectionError');
  };
}

function send(data: object | string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

// ─── Control message handlers ──────────────────────────────────

function handleControl(msg: any) {
  switch (msg.type) {
    case "created":
      reconnectAttempts = 0;
      sessions.value.push({
        id: msg.id,
        shell: msg.shell,
        pid: msg.pid,
        title: `${msg.shell} #${sessions.value.length + 1}`,
        createdAt: Date.now(),
        exited: false,
      });
      switchSession(msg.id);
      break;

    case "exited": {
      const s = sessions.value.find((s) => s.id === msg.id);
      if (s) {
        s.exited = true;
        if (activeSessionId.value === msg.id) {
          activeTerm?.write(
            `\r\n\x1b[90m[${t("terminal.processExited", { code: msg.exitCode })}]\x1b[0m\r\n`,
          );
        }
      }
      break;
    }

    case "error":
      message.error(msg.message);
      break;
  }
}

// ─── Session actions ────────────────────────────────────────────

function createSession() {
  send({ type: "create" });
}

function getOrCreateTerm(id: string): { term: Terminal; fitAddon: FitAddon } {
  let entry = termMap.get(id);
  if (!entry) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { ...TERMINAL_THEMES[selectedTheme.value].theme },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    entry = { term, fitAddon, opened: false };
    termMap.set(id, entry);
  }
  return entry;
}

function switchSession(id: string) {
  if (activeSessionId.value === id) return;
  activeSessionId.value = id;
  const entry = getOrCreateTerm(id);
  activeTerm = entry.term;
  activeFitAddon = entry.fitAddon;
  mountActiveTerminal();
  send({ type: "switch", sessionId: id });
}

function closeSession(id: string) {
  send({ type: "close", sessionId: id });
  sessions.value = sessions.value.filter((s) => s.id !== id);
  const entry = termMap.get(id);
  if (entry) {
    entry.term.dispose();
    termMap.delete(id);
  }
  if (activeSessionId.value === id) {
    activeSessionId.value = sessions.value.length > 0 ? sessions.value[0].id : null;
    activeTerm = null;
    activeFitAddon = null;
    if (activeSessionId.value) {
      switchSession(activeSessionId.value);
    } else {
      unmountActiveTerminal();
      createSession();
    }
  }
}

// ─── Terminal mount/unmount ─────────────────────────────────────

function mountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);

  const entry = termMap.get(activeSessionId.value!);
  if (!entry) return;

  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else {
    const termEl = entry.term.element;
    if (termEl) {
      container.appendChild(termEl);
    }
  }

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    tryFit();
    sendResize();
  });
  resizeObserver.observe(terminalRef.value);

  setTimeout(() => tryFit(), 50);
  setTimeout(() => tryFit(), 200);
}

function unmountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);
}

function tryFit() {
  if (!activeFitAddon) return;
  try {
    activeFitAddon.fit();
  } catch {}
}

function sendResize() {
  if (!activeTerm || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    send({
      type: "resize",
      cols: activeTerm.cols,
      rows: activeTerm.rows,
    });
  } catch {}
}

// ─── Theme ───────────────────────────────────────────────────────

function applyTheme(themeName: string) {
  selectedTheme.value = themeName;
  localStorage.setItem(STORAGE_KEY_THEME, themeName);
  const themeObj = TERMINAL_THEMES[themeName]?.theme;
  if (!themeObj) return;
  for (const entry of termMap.values()) {
    entry.term.options.theme = { ...themeObj };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Lifecycle ──────────────────────────────────────────────────

let hasConnected = false;

watch(() => props.visible, (visible) => {
  if (visible && !hasConnected && !ws) {
    hasConnected = true;
    connect();
  }
}, { immediate: true });

onUnmounted(() => {
  unmountActiveTerminal();
  for (const entry of termMap.values()) {
    entry.term.dispose();
  }
  termMap.clear();
  activeTerm = null;
  activeFitAddon = null;
  ws?.close();
  ws = null;
});
</script>

<template>
  <div class="terminal-panel-drawer">
    <div
      v-if="showSidebar"
      class="sidebar-overlay"
      @click="showSidebar = false"
    ></div>
    <div
      class="terminal-sidebar"
      :class="{ 'mobile-visible': showSidebar }"
    >
      <div class="sidebar-header">
        <span class="sidebar-title">{{ t("terminal.sessions") }}</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary size="tiny" @click="createSession" circle>
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </template>
            </NButton>
          </template>
          {{ t("terminal.newTab") }}
        </NTooltip>
      </div>
      <div class="session-list">
        <div v-if="connectionError" class="session-error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{{ connectionError }}</span>
          <NButton size="tiny" @click="connect">{{ t("common.retry") }}</NButton>
        </div>
        <div v-else-if="sessions.length === 0" class="session-empty">
          <template v-if="isConnecting">
            {{ t("common.loading") }}
          </template>
          <template v-else>
            {{ t("terminal.noSessions") }}
          </template>
        </div>
        <button
          v-for="s in sessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === activeSessionId, exited: s.exited }"
          @click="switchSession(s.id)"
        >
          <div class="session-item-content">
            <span class="session-item-title">{{ s.title }}</span>
            <span class="session-item-meta">
              <span class="session-item-shell">{{ s.shell }}</span>
              <span v-if="s.exited" class="session-item-status">{{
                t("terminal.sessionExited")
              }}</span>
              <span v-else class="session-item-time">{{
                formatTime(s.createdAt)
              }}</span>
            </span>
          </div>
          <NPopconfirm v-if="sessions.length > 1" @positive-click="closeSession(s.id)">
            <template #trigger>
              <button class="session-item-delete" @click.stop>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </template>
            {{ t("terminal.closeSession") }}
          </NPopconfirm>
        </button>
      </div>
    </div>

    <div class="terminal-main">
      <header class="terminal-header">
        <span v-if="activeSession" class="header-session-title">{{
          activeSession.title
        }}</span>
        <div class="header-actions">
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
            {{ t("terminal.sessions") }}
          </NButton>
          <NSelect
            :value="selectedTheme"
            :options="themeOptions"
            size="small"
            :consistent-menu-width="false"
            class="theme-select"
            @update:value="applyTheme"
          />
          <NButton size="small" @click="createSession">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
            {{ t("terminal.newTab") }}
          </NButton>
        </div>
      </header>
      <div class="terminal-container">
        <div ref="terminalRef" class="terminal-xterm" :style="{ backgroundColor: terminalBg }" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.terminal-panel-drawer {
  display: flex;
  height: 100%;
  min-height: 0;
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

.terminal-sidebar {
  width: 180px;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;

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

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
  border-bottom: 1px solid $border-color;
}

.sidebar-title {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-empty {
  padding: 16px 8px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.session-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 12px;
  font-size: 12px;
  color: $error;
  text-align: center;

  svg {
    width: 32px;
    height: 32px;
    opacity: 0.8;
  }

  span {
    flex: 1;
  }
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
    color: $text-primary;
    font-weight: 500;
  }

  &.exited {
    opacity: 0.5;
  }
}

.session-item-content {
  flex: 1;
  overflow: hidden;
}

.session-item-title {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.session-item-shell {
  font-size: 9px;
  color: $accent-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
}

.session-item-time,
.session-item-status {
  font-size: 10px;
  color: $text-muted;
}

.session-item-delete {
  flex-shrink: 0;
  opacity: 0.5;
  padding: 2px;
  border: none;
  background: none;
  color: $text-muted;
  cursor: pointer;
  border-radius: 3px;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba(var(--error-rgb), 0.1);
  }
}

.terminal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-session-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.theme-select {
  width: 120px;
}

.sidebar-toggle {
  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }
}

.terminal-container {
  flex: 1;
  margin: 8px;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.terminal-xterm {
  flex: 1;
  border-radius: $radius-md;
  overflow: hidden;
  border: 1px solid $border-color;

  :deep(.xterm) {
    height: 100%;
    padding: 8px;
  }

  :deep(.xterm-viewport) {
    overflow-y: scroll !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
    background-color: transparent !important;
  }

  :deep(.xterm-viewport::-webkit-scrollbar) {
    display: none !important;
  }

  :deep(.xterm-screen) {
    background-color: transparent !important;
  }

  :deep(.xterm-scrollable-element) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }

  :deep(.xterm-scrollable-element::-webkit-scrollbar) {
    display: none !important;
  }
}
</style>
