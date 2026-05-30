<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import VirtualMessageList from "./VirtualMessageList.vue";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";
import type { Session } from "@/stores/hermes/chat";

const props = defineProps<{
  session?: Session | null; // Optional: use this session instead of chatStore.activeSession
  loadOlder?: (sessionId: string) => Promise<boolean>;
}>();

const chatStore = useChatStore();
const { toolTraceVisible } = useToolTraceVisibility();
const { t } = useI18n();
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);
const pendingBottomSessionId = ref<string | null>(null);

// Use provided session or fall back to chatStore's active session
const activeSession = computed(() => props.session || chatStore.activeSession);

const displayMessages = computed(() =>
  (activeSession.value?.messages || []).filter((m) => {
    // Tool messages without a name are internal use only and remain hidden.
    if (m.role === 'tool') return toolTraceVisible.value && !!m.toolName
    // Filter out messages with empty content.
    if (!m.content?.trim()) return false
    return true
  }),
);

function isNearBottom(threshold = 200): boolean {
  return listRef.value?.isNearBottom(threshold) ?? true;
}

function scrollToBottom() {
  listRef.value?.scrollToBottom();
}

function scrollToMessage(messageId: string) {
  listRef.value?.scrollToMessage(messageId);
}

function scrollToAnchor(messageId: string, anchorId: string) {
  listRef.value?.scrollToAnchor(messageId, anchorId);
}

async function handleTopReach() {
  const session = activeSession.value;
  if (!session?.hasMoreBefore || session.isLoadingOlderMessages || !props.loadOlder) return;
  const snapshot = listRef.value?.captureScrollPosition() ?? null;
  const loaded = await props.loadOlder(session.id);
  if (!loaded) return;
  await nextTick();
  listRef.value?.restoreScrollPosition(snapshot);
}

// Scroll to bottom on session switch
watch(
  () => activeSession.value?.id,
  (id) => {
    if (!id) return;
    pendingBottomSessionId.value = id;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    scrollToBottom();
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
    const id = activeSession.value?.id
    const shouldForceBottom = !!id && pendingBottomSessionId.value === id
    if (!shouldForceBottom && !isNearBottom()) return;
    if (shouldForceBottom) pendingBottomSessionId.value = null
    scrollToBottom();
  },
  { flush: "post" },
);

defineExpose({
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
});
</script>

<template>
  <VirtualMessageList
    ref="listRef"
    :messages="displayMessages"
    @top-reach="handleTopReach"
  >
    <template #empty>
      <div class="empty-state">
        <img src="/logo.png" alt="Hermes" class="empty-logo" />
        <p>{{ t("chat.emptyState") }}</p>
      </div>
    </template>
    <template #before>
      <div
        v-if="activeSession?.hasMoreBefore || activeSession?.isLoadingOlderMessages"
        class="history-loader"
      >
        <span v-if="activeSession?.isLoadingOlderMessages" class="history-loader-spinner"></span>
      </div>
    </template>
    <template #item="{ message: msg }">
      <MessageItem
        :message="msg"
        :highlight="chatStore.focusMessageId === msg.id"
      />
    </template>
  </VirtualMessageList>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

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

@keyframes spin {
  to {
    transform: rotate(360deg);
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
