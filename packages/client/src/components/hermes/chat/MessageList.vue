<script lang="ts">
type SessionScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

type BottomScrollOptions = number | {
  frames?: number;
  keepAliveMs?: number;
}

const sessionScrollPositions = new Map<string, SessionScrollSnapshot>();
</script>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NButton, NInput } from "naive-ui";
import VirtualMessageList from "./VirtualMessageList.vue";
import MessageItem from "./MessageItem.vue";
import { LIVE_CHAT_MAX_LOADED_MESSAGES, useChatStore, type Message } from "@/stores/hermes/chat";
import thinkingImage from "@/assets/thinking.gif";
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";

const props = withDefaults(defineProps<{
  approvalPortalToBody?: boolean
}>(), {
  approvalPortalToBody: false,
})

const chatStore = useChatStore();
const { t } = useI18n();
const { toolTraceVisible } = useToolTraceVisibility();
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);
const pendingInitialScrollSessionId = ref<string | null>(null);
const showScrollBottomButton = ref(false);
const thinkingElapsedMs = ref(0);
const initialBottomScrollOptions = { frames: 8, keepAliveMs: 1200 };
let thinkingStartedAt = 0;
let thinkingTimer: ReturnType<typeof setInterval> | null = null;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatToolDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}m ${secs}s`
}

function toolPreviewText(preview?: string): string {
  const text = String(preview || '')
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h${mins}m${secs}s`;
  if (mins > 0) return `${mins}m${secs}s`;
  return `${secs}s`;
}

function stopThinkingTimer() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

const isThinkingIndicatorVisible = computed(() => chatStore.isRunActive || !!chatStore.abortState);
const formattedThinkingElapsed = computed(() => formatElapsed(thinkingElapsedMs.value));

const currentToolCalls = computed(() => {
  const msgs = chatStore.messages;
  // Slash commands are also user input boundaries for the live tool strip.
  let lastInputIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" || msgs[i].role === "command") {
      lastInputIdx = i;
      break;
    }
  }
  // Only tool calls after the last user input, newest on top.
  const tools = msgs.filter((m, i) => m.role === "tool" && i > lastInputIdx);
  return [...tools].reverse();
});

const visibleToolCalls = computed(() =>
  currentToolCalls.value.filter((tool) => !!tool.toolName),
);

const emptyState = computed(() => {
  const session = chatStore.activeSession;
  const codingAgentId = session?.codingAgentId || (session?.agent === "codex" ? "codex" : session?.agent === "claude" ? "claude-code" : session?.agent === "ekko-agent" ? "ekko-agent" : undefined);
  if (codingAgentId === "codex") {
    return {
      logo: "/coding-agents/codex-openai.png",
      alt: "Codex",
      text: t("chat.emptyStateAgent", { agent: "Codex" }),
    };
  }
  if (codingAgentId === "claude-code") {
    return {
      logo: "/coding-agents/claude-code.svg",
      alt: "Claude Code",
      text: t("chat.emptyStateAgent", { agent: "Claude Code" }),
    };
  }
  if (codingAgentId === "ekko-agent") {
    return {
      logo: "/coding-agents/ekko-agent.png",
      alt: "Ekko Agent",
      text: t("chat.emptyStateAgent", { agent: "Ekko Agent" }),
    };
  }
  return {
    logo: "/coding-agents/hermes.png",
    alt: "Hermes",
    text: t("chat.emptyState"),
  };
});

const displayMessages = computed(() => {
  const currentToolIds = new Set(currentToolCalls.value.map((tool) => tool.id));
  return chatStore.messages.filter((m) => {
    if (m.role === "tool") {
      return toolTraceVisible.value && !!m.toolName && !(chatStore.isRunActive && currentToolIds.has(m.id));
    }
    if (
      m.role === "assistant" &&
      m.isStreaming &&
      !m.content?.trim() &&
      !!m.reasoning?.trim() &&
      currentToolCalls.value.length === 0
    ) {
      return false;
    }
    return true;
  });
});

function forkDividerId(sessionId: string): string {
  return `fork-divider-${sessionId}`;
}

const displayMessagesWithForkDivider = computed<Message[]>(() => {
  const messages = displayMessages.value;
  const lineage = forkLineage.value;
  const session = chatStore.activeSession;
  if (!lineage || !session?.forkPointMessageId) return messages;

  const forkPoint = String(session.forkPointMessageId);
  const index = messages.findIndex((message) => String(message.id) === forkPoint);
  if (index < 0) return messages;

  const divider: Message = {
    id: forkDividerId(session.id),
    role: "system",
    content: "",
    timestamp: session.updatedAt || Date.now(),
    systemType: "fork-divider",
  };
  return [
    ...messages.slice(0, index + 1),
    divider,
    ...messages.slice(index + 1),
  ];
});

const canForkActiveSession = computed(() => {
  const session = chatStore.activeSession;
  const hasConversation = displayMessages.value.some((message) => message.role === "user" || message.role === "assistant");
  return !!session && session.source !== "coding_agent" && !chatStore.isStreaming && !chatStore.isForkPending && hasConversation;
});

const lastForkActionMessageId = computed(() => {
  const messages = displayMessagesWithForkDivider.value;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" || message.role === "assistant") return message.id;
  }
  return null;
});

const queuedMessages = computed(() => {
  const sid = chatStore.activeSessionId;
  if (!sid) return [];
  return chatStore.queuedUserMessages.get(sid) || [];
});
const visibleApproval = computed(() => chatStore.activePendingApproval);
const visibleClarify = computed(() => chatStore.activePendingClarify);
const clarifyResponse = ref("");
const hasFloatingPrompt = computed(() => !!visibleApproval.value || !!visibleClarify.value);
const virtualListPadding = computed(() => {
  if (queuedMessages.value.length > 0 && hasFloatingPrompt.value) return "20px 20px 380px";
  if (queuedMessages.value.length > 0 || hasFloatingPrompt.value) return "20px 20px 260px";
  return "20px";
});

const showHistoryArchiveLink = computed(() => {
  const session = chatStore.activeSession;
  return !!session?.hasMoreBefore && (session.loadedMessageCount || 0) >= LIVE_CHAT_MAX_LOADED_MESSAGES;
});

const historyArchiveHref = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.id) return "#/hermes/history";
  const profileQuery = session.profile ? `?profile=${encodeURIComponent(session.profile)}` : "";
  return `#/hermes/history/session/${encodeURIComponent(session.id)}${profileQuery}`;
});

const forkLineage = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.parentSessionId) return null;
  return {
    parentSessionId: session.parentSessionId,
    parentTitle: session.parentTitle || session.parentSessionId,
    parentHref: `#/hermes/history/session/${encodeURIComponent(session.parentSessionId)}${session.profile ? `?profile=${encodeURIComponent(session.profile)}` : ""}`,
    canSwitchParent: chatStore.sessions.some((item) => item.id === session.parentSessionId),
    lastRole: session.parentLastMessageRole || "",
    lastMessage: session.parentLastMessage || "",
  };
});

async function openForkParent(event?: MouseEvent) {
  const lineage = forkLineage.value;
  if (!lineage?.parentSessionId) return;
  if (lineage.canSwitchParent) {
    event?.preventDefault();
    await chatStore.switchSession(lineage.parentSessionId);
    return;
  }
  window.location.hash = lineage.parentHref.replace(/^#/, "");
}

function handleApproval(choice: "once" | "session" | "always" | "deny") {
  chatStore.respondApproval(choice);
}

function handleClarify(response?: string) {
  const finalResponse = response !== undefined ? response : clarifyResponse.value.trim();
  chatStore.respondToClarify(finalResponse);
  clarifyResponse.value = "";
}

function removeQueuedMessage(messageId: string) {
  const sid = chatStore.activeSessionId;
  if (!sid) return;
  chatStore.removeQueuedMessage(sid, messageId);
}

function queuedPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function shouldAutoFollowBottom(threshold = 100): boolean {
  return listRef.value?.shouldAutoFollowBottom(threshold) ?? true;
}

function scrollToBottom(options?: BottomScrollOptions) {
  listRef.value?.scrollToBottom(options);
  showScrollBottomButton.value = false;
}

function scrollToMessage(messageId: string) {
  listRef.value?.scrollToMessage(messageId);
}

function scrollToAnchor(messageId: string, anchorId: string) {
  listRef.value?.scrollToAnchor(messageId, anchorId);
}

function updateScrollBottomButton() {
  showScrollBottomButton.value = displayMessages.value.length > 0 && !(listRef.value?.isNearBottom(1000) ?? true);
}

function handleListScroll() {
  updateScrollBottomButton();
}

function handleScrollBottomClick() {
  scrollToBottom({ frames: 4, keepAliveMs: 600 });
}

function saveSessionScrollPosition(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const snapshot = listRef.value?.captureViewportPosition() ?? null;
  if (snapshot) sessionScrollPositions.set(sessionId, snapshot);
}

function applyInitialSessionScroll(sessionId: string) {
  if (chatStore.activeSessionId !== sessionId) return;
  if (chatStore.focusMessageId) {
    pendingInitialScrollSessionId.value = null;
    scrollToMessage(chatStore.focusMessageId);
    return;
  }

  const snapshot = sessionScrollPositions.get(sessionId);
  if (snapshot) {
    pendingInitialScrollSessionId.value = null;
    if (snapshot.wasNearBottom) {
      scrollToBottom(initialBottomScrollOptions);
    } else {
      listRef.value?.restoreViewportPosition(snapshot);
    }
    return;
  }

  const session = chatStore.activeSession;
  if (session?.parentSessionId && session.forkPointMessageId) {
    const dividerId = forkDividerId(session.id);
    const hasDivider = displayMessagesWithForkDivider.value.some((message) => message.id === dividerId);
    if (hasDivider) {
      pendingInitialScrollSessionId.value = null;
      scrollToMessage(dividerId);
      return;
    }
    if (chatStore.isLoadingMessages || chatStore.messages.length === 0) return;
  }

  scrollToBottom(initialBottomScrollOptions);
  if (chatStore.messages.length > 0 && !chatStore.isLoadingMessages) {
    pendingInitialScrollSessionId.value = null;
  }
}

async function handleTopReach() {
  const session = chatStore.activeSession;
  if (!session?.hasMoreBefore || session.isLoadingOlderMessages || showHistoryArchiveLink.value) return;
  const snapshot = listRef.value?.captureScrollPosition() ?? null;
  const loaded = await chatStore.loadOlderMessages(session.id);
  if (!loaded) return;
  await nextTick();
  listRef.value?.restoreScrollPosition(snapshot);
  updateScrollBottomButton();
}

watch(
  () => chatStore.activeSessionId,
  async (id, previousId) => {
    saveSessionScrollPosition(previousId);
    if (!id) return;
    pendingInitialScrollSessionId.value = id;
    await nextTick();
    applyInitialSessionScroll(id);
  },
  { immediate: true },
);

watch(
  () => [chatStore.activeSessionId, chatStore.messages.length] as const,
  ([id, length]) => {
    if (!id || pendingInitialScrollSessionId.value !== id || length === 0) return;
    applyInitialSessionScroll(id);
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

watch(
  () => displayMessages.value.length,
  () => {
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

watch(
  () => chatStore.isLoadingMessages,
  async (isLoading, wasLoading) => {
    if (isLoading || !wasLoading) return;
    const id = chatStore.activeSessionId;
    if (!id || pendingInitialScrollSessionId.value !== id) return;
    if (chatStore.focusMessageId) {
      pendingInitialScrollSessionId.value = null;
      return;
    }
    await nextTick();
    if (chatStore.activeSessionId !== id) return;
    applyInitialSessionScroll(id);
  },
  { flush: "post" },
);

watch(
  () => chatStore.focusMessageId,
  (messageId) => {
    if (!messageId) return;
    scrollToMessage(messageId);
  },
);

// When a run starts (user just sent a message), always scroll to bottom once
watch(
  () => chatStore.isRunActive,
  (v) => {
    if (v) scrollToBottom({ frames: 3, keepAliveMs: 400 });
  },
);

watch(
  isThinkingIndicatorVisible,
  (visible) => {
    stopThinkingTimer();
    if (!visible) {
      thinkingStartedAt = 0;
      thinkingElapsedMs.value = 0;
      return;
    }
    thinkingStartedAt = Date.now();
    thinkingElapsedMs.value = 0;
    thinkingTimer = setInterval(() => {
      thinkingElapsedMs.value = Date.now() - thinkingStartedAt;
    }, 1000);
  },
  { immediate: true },
);

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => chatStore.messages[chatStore.messages.length - 1]?.content,
  () => {
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    if (!shouldAutoFollowBottom()) return;
    scrollToBottom({ frames: 1, keepAliveMs: 0 });
  },
);
watch(currentToolCalls, () => {
  if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
  if (chatStore.focusMessageId) {
    scrollToMessage(chatStore.focusMessageId);
    return;
  }
  if (!shouldAutoFollowBottom()) return;
  scrollToBottom({ frames: 1, keepAliveMs: 0 });
});

watch(
  () => queuedMessages.value.length,
  async (length, previousLength) => {
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    if (chatStore.focusMessageId) return;
    if (length <= previousLength) return;
    const wasNearBottom = shouldAutoFollowBottom(320);
    await nextTick();
    if (!wasNearBottom && !chatStore.isRunActive) return;
    scrollToBottom({ frames: 4, keepAliveMs: 600 });
  },
);

onBeforeUnmount(() => {
  stopThinkingTimer();
  saveSessionScrollPosition(chatStore.activeSessionId);
});

onMounted(() => {
  void nextTick(updateScrollBottomButton);
});

defineExpose({
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
});
</script>

<template>
  <div class="message-list-shell">
    <VirtualMessageList
      :key="chatStore.activeSessionId || 'chat-empty'"
      ref="listRef"
      :messages="displayMessagesWithForkDivider"
      :virtualized="false"
      :padding="virtualListPadding"
      @scroll="handleListScroll"
      @top-reach="handleTopReach"
    >
      <template #empty>
        <div class="empty-state">
          <img :src="emptyState.logo" :alt="emptyState.alt" class="empty-logo" />
          <p>{{ emptyState.text }}</p>
        </div>
      </template>
      <template #before>
        <div v-if="showHistoryArchiveLink" class="history-archive-link-wrap">
          <a class="history-archive-link" :href="historyArchiveHref">
            {{ t("chat.viewOlderInHistory") }}
          </a>
        </div>
        <div
          v-else-if="chatStore.activeSession?.hasMoreBefore || chatStore.activeSession?.isLoadingOlderMessages"
          class="history-loader"
        >
          <span v-if="chatStore.activeSession?.isLoadingOlderMessages" class="history-loader-spinner"></span>
        </div>
      </template>
      <template #item="{ message: msg }">
        <div v-if="msg.systemType === 'fork-divider' && forkLineage" class="fork-divider" role="separator">
          <div class="fork-divider-line" aria-hidden="true"></div>
          <div class="fork-divider-pill">
            <span class="fork-divider-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M6 3v6a4 4 0 0 0 4 4h4.2" />
                <path d="M18 9l4 4-4 4" />
                <path d="M6 21V3" />
                <circle cx="6" cy="5" r="2" />
                <circle cx="6" cy="19" r="2" />
              </svg>
            </span>
            <span class="fork-divider-text">{{ t("chat.forkedFrom") }}</span>
            <a class="fork-divider-link" :href="forkLineage.parentHref" @click="openForkParent">
              {{ forkLineage.parentTitle }}
            </a>
          </div>
          <div class="fork-divider-line" aria-hidden="true"></div>
        </div>
        <MessageItem
          v-else
          :message="msg"
          :highlight="chatStore.focusMessageId === msg.id"
          :show-fork-action="canForkActiveSession && msg.id === lastForkActionMessageId"
        />
      </template>
      <template #after>
        <Transition name="fade">
        <div v-if="isThinkingIndicatorVisible" class="streaming-indicator">
          <div class="thinking-status">
            <img
              :src="thinkingImage"
              alt=""
              aria-hidden="true"
              class="thinking-avatar"
            >
            <div class="thinking-status-copy">
              <span class="thinking-status-label">{{ t("chat.thinkingInProgress") }}</span>
              <span class="thinking-status-time">{{ formattedThinkingElapsed }}</span>
            </div>
          </div>
          <div v-if="visibleToolCalls.length > 0 || chatStore.compressionState || chatStore.abortState" class="tool-calls-panel">
            <!-- Abort indicator -->
            <div v-if="chatStore.abortState" class="tool-call-item compression-item">
              <svg
                v-if="chatStore.abortState.aborting"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M10 9v6m4-6v6M5 5h14v14H5z" />
              </svg>
              <svg
                v-else
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
              <span class="tool-call-name">
                {{
                  chatStore.abortState.aborting
                    ? chatStore.abortState.timedOut
                      ? (chatStore.abortState.message || 'Still stopping... new messages will be queued')
                      : 'Pausing... waiting for the run to stop and sync'
                    : chatStore.abortState.synced
                      ? 'Paused and synced'
                      : 'Paused'
                }}
              </span>
              <span
                v-if="chatStore.abortState.aborting"
                class="tool-call-spinner"
              ></span>
            </div>
            <!-- Compression indicator -->
            <div v-if="chatStore.compressionState" class="tool-call-item compression-item">
              <svg
                v-if="chatStore.compressionState.compressing"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <svg
                v-else-if="chatStore.compressionState.compressed"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
              <span class="tool-call-name">
                {{
                  chatStore.compressionState.compressing
                    ? `Compressing... (${chatStore.compressionState.messageCount} msgs, ~${formatTokens(chatStore.compressionState.beforeTokens)} tokens)`
                    : chatStore.compressionState.compressed
                      ? `Compressed ${chatStore.compressionState.messageCount} msgs: ~${formatTokens(chatStore.compressionState.beforeTokens)} → ~${formatTokens(chatStore.compressionState.afterTokens)} tokens`
                      : `Compression skipped`
                }}
              </span>
              <span
                v-if="chatStore.compressionState.compressing"
                class="tool-call-spinner"
              ></span>
            </div>
            <!-- Tool calls -->
            <div
              v-for="tc in visibleToolCalls"
              :key="tc.id"
              class="tool-call-item"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path
                  d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                />
              </svg>
              <span class="tool-call-name">{{ tc.toolName }}</span>
              <span
                v-if="tc.toolPreview"
                class="tool-call-preview"
                :title="tc.toolPreview"
              >{{ toolPreviewText(tc.toolPreview) }}</span>
              <span
                v-if="tc.toolDuration !== undefined && tc.toolStatus !== 'running'"
                class="tool-call-duration"
                :title="$t('chat.executionDuration')"
              >{{ formatToolDuration(tc.toolDuration) }}</span
              >
              <svg
                v-if="tc.toolStatus === 'done'"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                class="tool-call-success-icon"
              >
                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                <path
                  d="M8 12L11 15L16 9"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  fill="none"
                />
              </svg>
              <span
                v-if="tc.toolStatus === 'running'"
                class="tool-call-spinner"
              ></span>
              <svg
                v-if="tc.toolStatus === 'error'"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                class="tool-call-error-icon"
              >
                <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                <path
                  d="M15 9L9 15M9 9L15 15"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  fill="none"
                />
              </svg>
            </div>
          </div>
        </div>
        </Transition>
      </template>
    </VirtualMessageList>
    <button
      v-if="showScrollBottomButton"
      type="button"
      class="scroll-bottom-button"
      :aria-label="t('chat.scrollToBottom')"
      :title="t('chat.scrollToBottom')"
      @click="handleScrollBottomClick"
    >
      <svg
        class="scroll-bottom-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m7 10 5 5 5-5" />
        <path d="M6 19h12" />
      </svg>
    </button>
    <div
      v-if="visibleApproval || visibleClarify || queuedMessages.length > 0"
      class="message-float-stack"
    >
    <Teleport to="body" :disabled="!props.approvalPortalToBody">
      <Transition name="queue-float">
        <div
          v-if="visibleApproval"
          class="approval-float-panel"
          :class="{ 'approval-float-panel--global': props.approvalPortalToBody }"
        >
          <div class="float-panel-header">
            <span class="approval-float-icon" aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            <span>{{ t("chat.approvalKicker") }}</span>
          </div>
          <div class="approval-float-title">{{ t("chat.approvalTitle") }}</div>
          <div class="approval-float-desc">{{ visibleApproval.description }}</div>
          <code class="approval-float-command">{{ visibleApproval.command }}</code>
          <div class="approval-float-actions">
            <NButton
              v-if="visibleApproval.isMemoryWrite"
              size="small"
              type="primary"
              @click="handleApproval('once')"
            >
              {{ t("chat.approvalAgree") }}
            </NButton>
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('once')"
              size="small"
              type="primary"
              @click="handleApproval('once')"
            >
              {{ t("chat.approvalAllowOnce") }}
            </NButton>
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('session')"
              size="small"
              secondary
              @click="handleApproval('session')"
            >
              {{ t("chat.approvalAllowSession") }}
            </NButton>
            <NButton
              v-if="!visibleApproval.isMemoryWrite && visibleApproval.choices.includes('always')"
              size="small"
              secondary
              @click="handleApproval('always')"
            >
              {{ t("chat.approvalAlways") }}
            </NButton>
            <NButton
              v-if="visibleApproval.isMemoryWrite || visibleApproval.choices.includes('deny')"
              size="small"
              type="error"
              secondary
              @click="handleApproval('deny')"
            >
              {{ t("chat.approvalDeny") }}
            </NButton>
          </div>
        </div>
      </Transition>
    </Teleport>
      <Transition name="queue-float">
        <div v-if="!visibleApproval && visibleClarify" class="approval-float-panel">
          <div class="float-panel-header">
            <span class="approval-float-icon" aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <span>{{ t("chat.clarifyKicker") }}</span>
          </div>
          <div class="approval-float-title">{{ t("chat.clarifyTitle") }}</div>
          <div class="approval-float-desc">{{ visibleClarify.question }}</div>
          <div v-if="visibleClarify.choices && visibleClarify.choices.length" class="approval-float-actions">
            <NButton
              v-for="choice in visibleClarify.choices"
              :key="choice"
              size="small"
              type="primary"
              @click="handleClarify(choice)"
            >
              {{ choice }}
            </NButton>
            <NButton size="small" type="error" secondary @click="handleClarify('')">
              {{ t("chat.clarifyDismiss") }}
            </NButton>
          </div>
          <div v-else class="clarify-float-input-row">
            <NInput
              v-model:value="clarifyResponse"
              size="small"
              :placeholder="t('chat.clarifyPlaceholder')"
            />
            <NButton size="small" type="primary" @click="handleClarify()">
              {{ t("chat.clarifySubmit") }}
            </NButton>
          </div>
        </div>
      </Transition>
      <Transition name="queue-float">
        <div v-if="queuedMessages.length > 0" class="queue-float-panel">
          <div class="queue-float-header">
            <span class="queue-orbit" aria-hidden="true">
              <span></span>
            </span>
            <span>{{ t('chat.messageQueue') }}</span>
            <strong>{{ queuedMessages.length }}</strong>
          </div>
          <div class="queue-float-list">
            <div
              v-for="(message, index) in queuedMessages"
              :key="message.id"
              class="queue-float-item"
            >
              <span class="queue-index">{{ index + 1 }}</span>
              <span class="queue-text">{{ queuedPreview(message.content) }}</span>
              <button
                type="button"
                class="queue-remove"
                :title="t('chat.removeQueuedMessage')"
                @click="removeQueuedMessage(message.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list-shell {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.message-float-stack {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(720px, calc(100% - 32px));
  pointer-events: none;
}

.scroll-bottom-button {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 7;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.94);
  color: var(--accent-primary);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  padding: 0;
  cursor: pointer;

  .dark & {
    background: rgba(38, 38, 38, 0.94);
  }
}

.scroll-bottom-button:hover {
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.scroll-bottom-icon {
  width: 19px;
  height: 19px;
}

.approval-float-panel,
.queue-float-panel {
  pointer-events: auto;
  width: 100%;
  padding: 10px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.22);
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(14px);

  .dark & {
    background: #262626;
  }
}

.approval-float-panel {
  border-color: rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-panel--global {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  width: min(720px, calc(100vw - 32px));
}

.queue-float-panel {
  align-self: flex-end;
  width: min(380px, 100%);
}

.float-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: var(--accent-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.approval-float-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-title {
  padding: 0 4px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

.approval-float-desc {
  padding: 0 4px;
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

.approval-float-command {
  display: block;
  margin: 8px 4px 0;
  max-height: 96px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: $text-primary;
  background: rgba(255, 255, 255, 0.68);
  border: 1px solid $border-color;
  border-radius: 11px;
  padding: 8px 10px;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.approval-float-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;
}

.clarify-float-input-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;

  :deep(.n-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  :deep(.n-button) {
    flex: 0 0 auto;
  }
}

.queue-float-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;

  strong {
    margin-left: auto;
    min-width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.16);
    color: var(--accent-info);
  }
}

.queue-orbit {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-info-rgb), 0.28);
  position: relative;
  animation: queue-spin 1.6s linear infinite;

  span {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    right: -2px;
    top: 5px;
    background: var(--accent-info);
    box-shadow: 0 0 12px rgba(var(--accent-info-rgb), 0.65);
  }
}

.queue-float-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 172px;
  overflow-y: auto;
}

.queue-float-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 7px 8px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.68);
  color: $text-primary;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.queue-index {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--accent-info);
  background: rgba(var(--accent-info-rgb), 0.12);
}

.queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.queue-remove {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba($error, 0.1);
  }
}

@media (max-width: 640px) {
  .message-float-stack {
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    gap: 8px;
  }

  .approval-float-panel,
  .queue-float-panel {
    padding: 7px;
    border-radius: 14px;
  }

  .approval-float-panel--global {
    left: 8px;
    right: 8px;
    bottom: max(8px, env(safe-area-inset-bottom));
    width: auto;
  }

  .queue-float-header {
    padding: 0 2px;
    font-size: 11px;

    span:nth-child(2) {
      display: none;
    }
  }

  .queue-orbit {
    width: 16px;
    height: 16px;

    span {
      width: 5px;
      height: 5px;
      top: 5px;
    }
  }

  .queue-float-list {
    margin-top: 6px;
    max-height: min(220px, 34dvh);
    overflow-y: auto;
  }

  .queue-float-item {
    min-height: 30px;
    padding: 5px 6px;
  }

  .queue-index {
    width: 18px;
    height: 18px;
    border-radius: 6px;
    font-size: 10px;
  }

  .queue-text {
    font-size: 11px;
  }

  .queue-remove {
    width: 22px;
    height: 22px;
  }

  .approval-float-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));

    :deep(.n-button) {
      width: 100%;
    }
  }

  .clarify-float-input-row {
    flex-direction: column;

    :deep(.n-button) {
      width: 100%;
    }
  }

  .tool-calls-panel .tool-call-item {
    width: 100%;
  }
}

@keyframes queue-spin {
  to {
    transform: rotate(360deg);
  }
}

.queue-float-enter-active,
.queue-float-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.queue-float-enter-from,
.queue-float-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;

  .empty-logo {
    width: 48px;
    height: 48px;
    opacity: 0.25;
  }

  p {
    font-size: 14px;
  }
}

.history-loader {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.history-loader-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.16);
  border-top-color: $accent-primary;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;

  .dark & {
    border-color: rgba(255, 255, 255, 0.18);
    border-top-color: $accent-primary;
  }
}

.history-archive-link-wrap {
  display: flex;
  justify-content: center;
  padding-bottom: 8px;
}

.history-archive-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 28px;
  padding: 5px 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: var(--accent-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  text-decoration: none;
  white-space: normal;
  text-align: center;
}

.history-archive-link:hover {
  background: rgba(var(--accent-primary-rgb), 0.14);
}

 .fork-divider {
  display: grid;
  grid-template-columns: minmax(24px, 1fr) auto minmax(24px, 1fr);
  align-items: center;
  gap: 12px;
  width: min(760px, 100%);
  margin: 12px auto 18px;
  color: var(--text-secondary);
}

.fork-divider-line {
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-primary-rgb), 0.26), transparent);
}

.fork-divider-pill {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: min(560px, calc(100vw - 56px));
  padding: 7px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  background: var(--bg-card);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
  font-size: 12px;
  line-height: 1.35;
}

.fork-divider-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--accent-primary);
  flex: 0 0 auto;
}

.fork-divider-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.fork-divider-text {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.fork-divider-link {
  overflow: hidden;
  max-width: 220px;
  color: var(--text-primary);
  font-weight: 700;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fork-divider-link:hover {
  color: var(--accent-primary);
  text-decoration: underline;
}


@media (max-width: 640px) {
  .fork-divider {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .fork-divider-line {
    display: none;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.streaming-indicator {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 4px;
  box-sizing: border-box;
}

.thinking-status {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 40px;
}

.thinking-avatar {
  width: 40px;
  height: 40px;
  border-radius: $radius-md;
  object-fit: cover;
  flex-shrink: 0;

  .dark & {
    filter: brightness(1.18) contrast(1.08) saturate(1.08);
  }
}

.thinking-status-copy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
  min-height: 20px;
}

.thinking-status-label {
  display: inline-flex;
  align-items: center;
  color: transparent;
  background: linear-gradient(105deg, $text-secondary 0%, $text-secondary 39%, #ffffff 48%, #ffffff 52%, $text-secondary 61%, $text-secondary 100%);
  background-size: 300% 100%;
  background-position: 0% 0;
  -webkit-background-clip: text;
  background-clip: text;
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  animation: thinking-label-shimmer 2.2s linear infinite;
  backface-visibility: hidden;
  contain: paint;
  transform: translateZ(0);
  will-change: background-position;

  .dark & {
    background: linear-gradient(105deg, #f0f0f0 0%, #f0f0f0 37%, #2f3540 47%, #2f3540 53%, #f0f0f0 63%, #f0f0f0 100%);
    background-size: 300% 100%;
    background-position: 0% 0;
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.16));
  }
}

.thinking-status-time {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
  color: $text-muted;
  font-family: $font-code;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  min-width: 44px;
}

@keyframes thinking-label-shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: 0% 0;
  }
}

.tool-calls-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}

.tool-call-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 520px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-size: 11px;
  color: $text-secondary;
  padding: 3px 8px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: $radius-sm;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }

  &.compression-item {
    color: $text-muted;
    font-size: 10px;

    .tool-call-name {
      flex: 1 1 auto;
      max-width: none;
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      overflow-wrap: anywhere;
    }
  }

  .tool-call-icon {
    flex-shrink: 0;
    color: $text-muted;
  }

  .tool-call-name {
    font-family: $font-code;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 34%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-call-preview {
    display: block;
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: none;
    color: $text-muted;
  }
}

.tool-call-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-call-error-icon {
  color: #ff4d4f;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tool-call-duration {
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
  margin-left: 4px;
  flex-shrink: 0;
}

.tool-call-success-icon {
  color: #52c41a;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
