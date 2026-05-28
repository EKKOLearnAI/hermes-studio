<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import VirtualMessageList from "./VirtualMessageList.vue";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";
import type { Session } from "@/stores/hermes/chat";

const props = defineProps<{
  session?: Session | null; // Optional: use this session instead of chatStore.activeSession
}>();

const chatStore = useChatStore();
const { toolTraceVisible } = useToolTraceVisibility();
const { t } = useI18n();
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);

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

// Scroll to bottom on session switch
watch(
  () => activeSession.value?.id,
  (id) => {
    if (!id) return;
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
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
</script>

<template>
  <VirtualMessageList
    ref="listRef"
    :messages="displayMessages"
  >
    <template #empty>
      <div class="empty-state">
        <img src="/logo.png" alt="Hermes" class="empty-logo" />
        <p>{{ t("chat.emptyState") }}</p>
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

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
