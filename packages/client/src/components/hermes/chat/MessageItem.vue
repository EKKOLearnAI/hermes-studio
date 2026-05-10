<script setup lang="ts">
import type { Message, ContentBlock } from "@/stores/hermes/chat";
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { downloadFile } from "@/api/hermes/download";
	import { getApiKey } from "@/api/client";
import { copyToClipboard } from "@/utils/clipboard";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import { parseThinking, countThinkingChars } from "@/utils/thinking-parser";
import { useChatStore } from "@/stores/hermes/chat";
import { useSettingsStore } from "@/stores/hermes/settings";
import {
  copyTextToClipboard,
  handleCodeBlockCopyClick,
  renderHighlightedCodeBlock,
} from "./highlight";
import { useGlobalSpeech } from "@/composables/useSpeech";
import { useVoiceSettings } from "@/composables/useVoiceSettings";

const TOOL_PAYLOAD_DISPLAY_LIMIT = 2000;

const props = defineProps<{ message: Message; highlight?: boolean }>();
const { t } = useI18n();
const toast = useMessage();

const isSystem = computed(() => props.message.role === "system");

// Parse ContentBlock[] from JSON string
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  if (!content.trim()) return null;

  try {
    // Try to parse as ContentBlock[] array
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      return parsed as ContentBlock[];
    }
  } catch {
    // Not valid JSON, treat as plain text
  }

  return null;
});

// Check if content is in ContentBlock[] format
const isContentBlockArray = computed(() => contentBlocks.value !== null);

// Extract text content from ContentBlock[] for display
const displayText = computed(() => {
  if (!isContentBlockArray.value) {
    return props.message.content || '';
  }

  // Extract text from blocks
  return contentBlocks.value!
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
});

// Extract files from ContentBlock[]
const contentFiles = computed(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.filter(block => block.type === 'image' || block.type === 'file');
});

// Generate download URL with auth token
function getDownloadUrl(path: string, name: string): string {
	const token = getApiKey();
	const base = `/api/hermes/download?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
	return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

const toolExpanded = ref(false);
const previewUrl = ref<string | null>(null);

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const speech = useGlobalSpeech();
const voiceSettings = useVoiceSettings();

// Copy entire bubble content
const copyableContent = computed(() => {
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  if (!content.trim()) return null
  return content
})

async function copyBubbleContent() {
  const text = copyableContent.value
  if (!text) return
  const ok = await copyToClipboard(text)
  if (ok) {
    toast.success(t('chat.copiedBubble'))
    return
  }
  toast.error(t('chat.copyFailed'))
}

const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);

// 优先使用来自 reasoning 字段/事件的思考文本；否则回退到从 content 解析的 <think> 标签。
// 若两者共存，则拼接展示（罕见，但保持信息不丢）。
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0));

const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking);

const thinkingFullText = computed(() => {
  const parts: string[] = [];
  if (props.message.reasoning) parts.push(props.message.reasoning);
  parts.push(...parsedThinking.value.segments);
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending);
  return parts.join("\n\n");
});

const thinkingCharCount = computed(() => {
  let count = countThinkingChars(parsedThinking.value);
  if (props.message.reasoning) count += props.message.reasoning.length;
  return count;
});

// 流式思考态：仍有未闭合 <think> 标签，或 reasoning 有内容但正文尚未开始。
const thinkingStreamingNow = computed(() => {
  if (!props.message.isStreaming) return false;
  if (parsedThinking.value.pending !== null) return true;
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

const thinkingOverride = ref<boolean | null>(null);

const thinkingExpanded = computed(() => {
  if (thinkingStreamingNow.value) return true;
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  return !!settingsStore.display.show_reasoning;
});

function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

const nowTick = ref(Date.now());
let tickTimer: number | null = null;

function ensureTick() {
  const ob = chatStore.getThinkingObservation(props.message.id);
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

watchEffect(ensureTick);

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  if (!ob?.startedAt) return null;
  const startedAt = ob.startedAt!; // Non-null assertion after check
  const end = ob?.endedAt ?? (props.message.isStreaming ? nowTick.value : startedAt);
  return Math.max(0, end - startedAt);
});

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

const timeStr = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

function isImage(type: string): boolean {
  return type.startsWith("image/");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Extract the upload file path from message content for a given attachment.
 * Upload format in content: [File: name.txt](/tmp/hermes-uploads/abc123.txt)
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";

  // Try ContentBlock[] format first
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      const fileBlock = parsed.find((block: any) =>
        block.type === 'file' && block.name === attName
      );
      if (fileBlock && (fileBlock as any).path) {
        return (fileBlock as any).path;
      }
    }
  } catch {
    // Not valid JSON, continue to regex matching
  }

  // Fallback to markdown format: [File: name](path)
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].trim() === attName.trim()) return match[2];
  }

  return null;
}

function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    toast.info(t("download.downloading"));
    downloadFile(filePath, att.name).catch((err: Error) => {
      toast.error(err.message || t("download.downloadFailed"));
    });
    return;
  }
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

type ToolPayload = {
  full: string;
  display: string;
  language?: string;
};

function formatToolPayload(raw?: string): ToolPayload {
  if (!raw) {
    return { full: "", display: "" };
  }

  try {
    const full = JSON.stringify(JSON.parse(raw), null, 2);
    return {
      full,
      display:
        full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
          ? full.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
          : full,
      language: "json",
    };
  } catch {
    return {
      full: raw,
      display:
        raw.length > TOOL_PAYLOAD_DISPLAY_LIMIT
          ? raw.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
          : raw,
    };
  }
}

function renderToolPayload(content: string, language?: string): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
  });
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  if (source === "tool-args" && fullToolArgs.value) {
    const ok = await copyTextToClipboard(fullToolArgs.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  if (source === "tool-result" && fullToolResult.value) {
    const ok = await copyTextToClipboard(fullToolResult.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }

  const copyResult = await handleCodeBlockCopyClick(event);
  if (copyResult) toast.success(t("common.copied"));
  else if (copyResult === false) toast.error(t("chat.copyFailed"));
}

const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

const hasToolDetails = computed(
  () => !!(props.message.toolArgs || props.message.toolResult),
);

const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult));

const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);

const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(
    formattedToolResult.value,
    toolResultPayload.value.language,
  );
});

// 语音播放相关
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放
  if (props.message.role !== 'assistant') return false
  if (!copyableContent.value) return false
  // OpenAI / Custom / Edge 不依赖浏览器 Web Speech API
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge') return true
  return speech.isSupported
})

const isPlayingThisMessage = computed(() => {
  // OpenAI / Custom / Edge 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

const isPausedThisMessage = computed(() => {
  // OpenAI / Custom / Edge 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

function handleSpeechToggle() {
  if (!canPlaySpeech.value) {
    return
  }
  const content = props.message.content || ''

  // OpenAI TTS 模式
  if (voiceSettings.provider.value === 'openai') {
    const apiUrl = voiceSettings.openaiBaseUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] OpenAI TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      baseUrl: voiceSettings.openaiBaseUrl.value,
      apiKey: voiceSettings.openaiApiKey.value,
      model: voiceSettings.openaiModel.value,
      voice: voiceSettings.openaiVoice.value,
    })
    return
  }

  // 自定义端点模式（OpenAI 兼容，如 GPT-SoVITS）
  if (voiceSettings.provider.value === 'custom') {
    const apiUrl = voiceSettings.customUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] 自定义 TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      baseUrl: voiceSettings.customUrl.value,
      apiKey: voiceSettings.customApiKey.value || undefined,
    })
    return
  }

  // Edge TTS 模式
  if (voiceSettings.provider.value === 'edge') {
    // URL 为空时使用内建后端代理
    const apiUrl = voiceSettings.edgeUrl.value || '/api/tts/proxy'
    speech.openaiToggle(props.message.id, content, {
      baseUrl: apiUrl,
      voice: voiceSettings.edgeVoice.value,
    })
    return
  }

  // Web Speech API 模式
  if (voiceSettings.provider.value === 'webspeech') {
    const text = speech.extractReadableText(content)
    if (text) {
      speech.stop(false)
      speech.speakViaBrowser(props.message.id, text, {
        voiceName: voiceSettings.webspeechVoice.value || undefined,
      })
    }
    return
  }

  // 后备（无 provider 匹配时）
  speech.toggle(props.message.id, content)
}

// 监听自动播放事件
let autoPlayHandler: ((e: Event) => void) | null = null

onMounted(() => {
  autoPlayHandler = (e: Event) => {
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      const content = customEvent.detail.content || props.message.content || ''
      if (voiceSettings.provider.value === 'openai') {
        const apiUrl = voiceSettings.openaiBaseUrl.value
        if (apiUrl) speech.openaiPlay(props.message.id, content, {
          baseUrl: voiceSettings.openaiBaseUrl.value,
          apiKey: voiceSettings.openaiApiKey.value,
          model: voiceSettings.openaiModel.value,
          voice: voiceSettings.openaiVoice.value,
        })
      } else if (voiceSettings.provider.value === 'custom') {
        const apiUrl = voiceSettings.customUrl.value
        if (apiUrl) speech.openaiPlay(props.message.id, content, {
          baseUrl: voiceSettings.customUrl.value,
          apiKey: voiceSettings.customApiKey.value || undefined,
        })
      } else if (voiceSettings.provider.value === 'edge') {
        speech.openaiPlay(props.message.id, content, {
          baseUrl: '/api/tts/proxy',
          voice: voiceSettings.edgeVoice.value,
        })
      } else if (voiceSettings.provider.value === 'webspeech') {
        const text = speech.extractReadableText(content)
        if (text) {
          speech.stop(false)
          speech.speakViaBrowser(props.message.id, text, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
          })
        }
      } else {
        speech.enqueue(props.message.id, content)
      }
    }
  }
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

// 组件卸载时停止播放并清理事件监听
onBeforeUnmount(() => {
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
  }
  if (speech.currentMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <div
    class="message"
    :class="[message.role, { highlight }]"
    :id="`message-${message.id}`"
  >
    <template v-if="message.role === 'tool'">
      <div
        class="tool-line"
        :class="{ expandable: hasToolDetails }"
        @click="hasToolDetails && (toolExpanded = !toolExpanded)"
      >
        <svg
          v-if="hasToolDetails"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="tool-chevron"
          :class="{ rotated: toolExpanded }"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg
          v-else
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="tool-icon"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
          />
        </svg>
        <span class="tool-name">{{ message.toolName }}</span>
        <span
          v-if="message.toolPreview && !toolExpanded"
          class="tool-preview"
          >{{ message.toolPreview }}</span
        >
        <span
          v-if="message.toolStatus === 'running'"
          class="tool-spinner"
        ></span>
        <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{
          t("chat.error")
        }}</span>
      </div>
      <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
        <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
          <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
        </div>
        <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
          <div class="tool-detail-label">{{ t("chat.result") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="msg-body">
        <img
          v-if="message.role === 'assistant'"
          src="/logo.png"
          alt="Hermes"
          class="msg-avatar"
        />
        <div class="msg-content" :class="message.role">
          <div class="message-bubble" :class="{ system: isSystem, 'speech-playing': isPlayingThisMessage && !isPausedThisMessage }">
            <div v-if="hasAttachments" class="msg-attachments">
              <div
                v-for="att in message.attachments"
                :key="att.id"
                class="msg-attachment"
                :class="{ image: isImage(att.type) }"
              >
                <template v-if="isImage(att.type) && att.url">
                  <img
                    :src="att.url"
                    :alt="att.name"
                    class="msg-attachment-thumb"
                    @click="previewUrl = att.url"
                  />
                </template>
                <template v-else>
                  <div class="msg-attachment-file" @click="handleAttachmentDownload(att)" style="cursor: pointer;" :title="t('download.downloadFile')">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path
                        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span class="att-name">{{ att.name }}</span>
                    <span class="att-size">{{ formatSize(att.size) }}</span>
                    <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                </template>
              </div>
            </div>
            <div
              v-if="hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <div class="thinking-header" @click="toggleThinking">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="thinking-chevron"
                  :class="{ rotated: thinkingExpanded }"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span class="thinking-icon">💭</span>
                <span class="thinking-label">
                  {{
                    thinkingStreamingNow
                      ? t('chat.thinkingInProgress')
                      : t('chat.thinkingLabel')
                  }}
                </span>
                <span v-if="thinkingDurationMs !== null && thinkingDurationMs > 0" class="thinking-meta">
                  · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                </span>
                <span class="thinking-meta">
                  · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                </span>
              </div>
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>
            <MarkdownRenderer
              v-if="parsedThinking.body && message.role === 'assistant'"
              :content="parsedThinking.body"
            />

            <!-- Render user message content -->
            <template v-if="message.role === 'user'">
              <!-- ContentBlock[] format -->
              <template v-if="isContentBlockArray">
                <div v-if="contentFiles && contentFiles.length > 0" class="msg-attachments">
                  <div
                    v-for="(file, idx) in contentFiles"
                    :key="idx"
                    class="msg-attachment"
                    :class="{ image: file.type === 'image' }"
                  >
                    <template v-if="file.type === 'image'">
                      <img
                        :src="getDownloadUrl(file.path, file.name)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getDownloadUrl(file.path, file.name)"
                      />
                    </template>
                    <template v-else>
                      <div
                        class="msg-attachment-file"
                        @click="downloadFile(file.path, file.name).catch(err => toast.error(err.message || t('download.downloadFailed')))"
                        style="cursor: pointer;"
                        :title="t('download.downloadFile')"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span class="att-name">{{ file.name }}</span>
                      </div>
                    </template>
                  </div>
                </div>
                <MarkdownRenderer v-if="displayText" :content="displayText" />
              </template>
              <!-- Plain text format -->
              <MarkdownRenderer v-else-if="message.content" :content="message.content" />
            </template>

            <!-- Render assistant message content -->
            <MarkdownRenderer
              v-if="message.role === 'assistant' && message.content && !parsedThinking.body"
              :content="message.content"
            />

            <span v-if="message.isStreaming && !message.content" class="streaming-dots">
              <span></span><span></span><span></span>
            </span>
          </div>
          <div class="message-meta">
            <button
              v-if="canPlaySpeech"
              class="speech-bubble-btn"
              :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
              @click="handleSpeechToggle"
              :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
            >
              <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>
            <button
              v-if="copyableContent"
              class="copy-bubble-btn"
              @click="copyBubbleContent"
              :title="t('chat.copyBubble')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <span class="message-time">{{ timeStr }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message {
  display: flex;
  flex-direction: column;
  position: relative;

  &.user {
    align-items: flex-end;

    .msg-body {
      max-width: 75%;
      position: relative;
      z-index: 1;
    }

    .msg-content.user {
      align-items: flex-end;
    }

    .message-bubble {
      background-color: $msg-user-bg;
      border-radius: 10px;
    }
  }

  &.assistant {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;

    .msg-body {
      max-width: 80%;
      position: relative;
      z-index: 1;
    }

    .msg-avatar {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .message-bubble {
      background-color: $msg-assistant-bg;
      border-radius: 10px;
    }
  }

  &.tool {
    align-items: flex-start;
  }

  &.system {
    align-items: flex-start;
  }

  &.highlight {
    .message-bubble {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }
}

@keyframes gradient-flow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.msg-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 85%;
}

.msg-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.message-bubble {
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  border-radius: 10px;
  max-width: 100%;
  position: relative;
  box-sizing: border-box;

  &.system {
    border-left: 3px solid $warning;
    border-radius: $radius-sm;
    max-width: 80%;
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.msg-attachment {
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.04);
  border: 1px solid $border-light;

  &.image {
    max-width: 200px;
  }
}

.msg-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 160px;
  object-fit: contain;
  cursor: pointer;
}

.msg-attachment-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: $text-secondary;

  .att-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .att-size {
    color: $text-muted;
    font-size: 11px;
    flex-shrink: 0;
  }
}

.thinking-block {
  margin-bottom: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed $border-light;

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: $text-muted;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: $radius-sm;
    user-select: none;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  .thinking-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .thinking-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .thinking-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .thinking-meta {
    color: $text-muted;
    font-variant-numeric: tabular-nums;
  }

  .thinking-body {
    margin-top: 6px;
    padding: 6px 10px;
    border-left: 2px solid $border-light;
    font-size: 13px;
    opacity: 0.85;
    font-style: italic;

    :deep(p) { margin: 0.3em 0; }
  }
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  opacity: 0;
  transition: opacity 0.15s ease;

  .message:hover & {
    opacity: 1;
  }

  // 移动端一直显示按钮
  @media (max-width: 768px) {
    opacity: 1;
  }
}

.copy-bubble-btn,
.speech-bubble-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  border-radius: $radius-sm;
  padding: 0;
  transition: color 0.15s ease, background 0.15s ease;

  &:hover {
    color: $text-secondary;
    background: rgba(0, 0, 0, 0.06);
  }

  .dark & {
    color: #999999;

    &:hover {
      color: #cccccc;
      background: rgba(255, 255, 255, 0.1);
    }
  }
}

.speech-bubble-btn {
  &.playing {
    color: var(--accent-primary);
    animation: pulse 1.5s ease-in-out infinite;

    &.paused {
      animation: none;
      opacity: 0.6;
    }
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.message-time {
  font-size: 11px;
  color: $text-muted;
  user-select: none;

  .dark & {
    color: #999999;
  }
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-muted;
  padding: 2px 4px;
  border-radius: $radius-sm;

  &.expandable {
    cursor: pointer;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  .tool-name {
    font-family: $font-code;
    flex-shrink: 0;
  }

  .tool-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 400px;
  }
}

.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-error-badge {
  font-size: 9px;
  color: $error;
  background: rgba(var(--error-rgb), 0.08);
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  margin-left: 4px;
}

.tool-details {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 2px solid $border-light;
  padding-left: 10px;
}

.tool-detail-section {
  margin-bottom: 6px;
}

.tool-detail-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}

.tool-detail-code-block {
  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: rgba(0, 0, 0, 0.02);
  }

  :deep(code.hljs) {
    font-size: 11px;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background-color: $text-muted;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s infinite;
}

.streaming-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;

  span {
    width: 6px;
    height: 6px;
    background-color: $text-muted;
    border-radius: 50%;
    animation: pulse 1.4s infinite ease-in-out;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .message.user .msg-body {
    max-width: 100%;
  }

  .message.assistant .msg-body {
    max-width: 100%;
  }

  .message.system .msg-body {
    max-width: 100%;
  }
}
</style>
