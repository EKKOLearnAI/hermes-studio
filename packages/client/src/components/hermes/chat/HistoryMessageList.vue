<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
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
const listRef = ref<HTMLElement>();

// Use provided session or fall back to chatStore's active session
const activeSession = computed(() => props.session || chatStore.activeSession);

const displayMessages = computed(() =>
  (activeSession.value?.messages || []).filter((m) => {
    // Tool messages without a name are internal use only and remain hidden.
    if (m.role === 'tool') return toolTraceVisible.value && !!m.toolName
    // Show assistant messages with reasoning even if content is empty
    if (m.role === 'assistant' && m.reasoning) return true
    // Always show user/visitor messages regardless of content
    if (m.role === 'user') return true
    // Filter out messages with empty content.
    if (!m.content?.trim()) return false
    return true
  }),
);