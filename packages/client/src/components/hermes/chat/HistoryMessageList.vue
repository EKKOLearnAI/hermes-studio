<script lang="ts">
type HistorySessionScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

const historySessionScrollPositions = new Map<string, HistorySessionScrollSnapshot>();
</script>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, watch } from "vue";
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
const pendingInitialScrollSessionId = ref<string | null>(null);
const activeSession = computed(() => props.session || null);
const listInstanceKey = computed(() => activeSession.value?.id ? `history-${activeSession.value.id}` : "history-empty");

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

function saveSessionScrollPosition(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const snapshot = listRef.value?.captureViewportPosition() ?? null;
  if (snapshot) historySessionScrollPositions.set(sessionId, snapshot);
}

function applyInitialSessionScroll(sessionId: string) {
  if (activeSession.value?.id !== sessionId) return;
  if (chatStore.focusMessageId) {
    pendingInitialScrollSessionId.value = null;
    scrollToMessage(chatStore.focusMessageId);
    return;
  }

  const snapshot = historySessionScrollPositions.get(sessionId);
  if (snapshot) {
    pendingInitialScrollSessionId.value = null;
    if (snapshot.wasNearBottom) {
      scrollToBottom();
    } else {
      listRef.value?.restoreViewportPosition(snapshot);
    }
    return;
  }

  scrollToBottom();
  if ((activeSession.value?.messages.length || 0) > 0) pendingInitialScrollSessionId.value = null;
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

watch(
  () => activeSession.value?.id,
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
    if (pendingInitialScrollSessionId.value === activeSession.value?.id) return;
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
    if (id && pendingInitialScrollSessionId.value === id) {
      applyInitialSessionScroll(id);
      return;
    }
    if (!isNearBottom()) return;
    scrollToBottom();
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  saveSessionScrollPosition(activeSession.value?.id);
});

defineExpose({
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
});
</script>

<template>
  <VirtualMessageList
    :key="listInstanceKey"
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
