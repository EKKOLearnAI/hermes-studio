<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import thinkingVideoLight from "@/assets/thinking-light.mp4";
import thinkingVideoDark from "@/assets/thinking-dark.mp4";
import { useTheme } from "@/composables/useTheme";

const chatStore = useChatStore();
const { t } = useI18n();
const { isDark } = useTheme();
const listRef = ref<HTMLElement>();

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

const displayMessages = computed(() =>
  chatStore.messages.filter((m) => m.role !== "tool"),
);

const currentToolCalls = computed(() => {
  const msgs = chatStore.messages;
  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  // Only tool calls after the last user message, newest on top
  const tools = msgs.filter((m, i) => m.role === "tool" && i > lastUserIdx);
  return [...tools].reverse();
});

function isNearBottom(threshold = 200): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) {
      listRef.value.scrollTop = listRef.value.scrollHeight;
    }
  });
}

function scrollToMessage(messageId: string) {
  nextTick(() => {
    const el = document.getElementById(`message-${messageId}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
    }
  });
}

// Scroll to bottom on session switch
watch(
  () => chatStore.activeSessionId,
  (id) => {
    if (!id) return;
    if (chatStore.focusMessageId) {
      nextTick(() => scrollToMessage(chatStore.focusMessageId!));
      return;
    }
    nextTick(() => scrollToBottom());
  },
  { immediate: true },
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
    if (v) scrollToBottom();
  },
);

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => chatStore.messages[chatStore.messages.length - 1]?.content,
  () => {
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
watch(currentToolCalls, () => {
  if (chatStore.focusMessageId) {
    scrollToMessage(chatStore.focusMessageId);
    return;
  }
  if (!isNearBottom()) return;
  scrollToBottom();
});
</script>

<template>
  <div ref="listRef" class="message-list">
    <div v-if="chatStore.messages.length === 0" class="empty-state">
      <img src="/logo.png" alt="Hermes" class="empty-logo" />
      <p>{{ t("chat.emptyState") }}</p>
    </div>
    <MessageItem
      v-for="msg in displayMessages"
      :key="msg.id"
      :message="msg"
      :highlight="chatStore.focusMessageId === msg.id"
    />
    <Transition name="fade">
      <div v-if="chatStore.isRunActive" class="streaming-indicator">
        <video
          :src="isDark ? thinkingVideoDark : thinkingVideoLight"
          autoplay
          loop
          muted
          playsinline
          class="thinking-video"
        />
        <div v-if="currentToolCalls.length > 0 || chatStore.compressionState" class="tool-calls-panel">
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
            v-for="tc in currentToolCalls"
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
            <span v-if="tc.toolPreview" class="tool-call-preview">{{
              tc.toolPreview
            }}</span>
            <span
              v-if="tc.toolDuration && tc.toolStatus !== 'running'"
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
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background-color: $bg-card;

  .dark & {
    background-color: #333333;
  }
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
  align-items: flex-start;
  gap: 12px;
  padding: 4px;
  .thinking-video {
    width: 120px;
    height: 213px;
    border-radius: $radius-md;
    object-fit: contain;
    flex-shrink: 0;
  }
}

.tool-calls-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 213px;
  overflow-y: auto;
  padding-top: 4px;
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
  }

  .tool-call-icon {
    flex-shrink: 0;
    color: $text-muted;
  }

  .tool-call-name {
    font-family: $font-code;
    flex-shrink: 0;
  }

  .tool-call-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
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
