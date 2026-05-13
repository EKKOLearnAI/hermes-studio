<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import type { Session } from "@/stores/hermes/chat";

const props = defineProps<{
  session?: Session | null; // Optional: use this session instead of chatStore.activeSession
}>();

const chatStore = useChatStore();
const { t } = useI18n();
const listRef = ref<HTMLElement>();

// Use provided session or fall back to chatStore's active session
const activeSession = computed(() => props.session || chatStore.activeSession);

const displayMessages = computed(() =>
  (activeSession.value?.messages || []).filter((m) => {
    // Filter out tool messages without name (internal use only)
    if (m.role === 'tool' && !m.toolName) return false
    // Filter out messages with empty content (except tool messages)
    if (m.role !== 'tool' && !m.content?.trim()) return false
    return true
  }),
);

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

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => (activeSession.value?.messages || [])[((activeSession.value?.messages || []).length - 1)]?.content,
  (content) => {
    if (!content) return
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);

watch(
  () => (activeSession.value?.messages || []).length,
  (length) => {
    if (length === 0) return
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
</script>

<template>
  <div ref="listRef" class="message-list">
    <div v-if="!activeSession || activeSession.messages.length === 0" class="empty-state">
      <img src="/logo.png" alt="Hermes" class="empty-logo" />
      <p>{{ t("chat.emptyState") }}</p>
    </div>
    <MessageItem
      v-for="msg in displayMessages"
      :key="msg.id"
      :message="msg"
      :highlight="chatStore.focusMessageId === msg.id"
    />
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
</style>
