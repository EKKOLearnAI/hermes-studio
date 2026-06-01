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
import { extractTerminalActionBlocks, stripTerminalActionBlocks, useTerminalActions } from "@/composables/useTerminalActions";
import { useGlobalSpeech } from "@/composables/useSpeech";
import { useVoiceSettings } from "@/composables/useVoiceSettings";
import { speedToEdgeRate, hzToEdgePitch } from "@/utils/ttsHelpers";
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock, copyTextToClipboard } from "./highlight";

const TOOL_SUMMARY_MAX_ITEMS = 8;
const TOOL_SUMMARY_STRING_LIMIT = 180;
const TOOL_PREVIEW_LIMIT = 96;
const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000;
const JSON_STRING_DISPLAY_LIMIT = 200;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_NODES = 1000;
const JSON_MAX_KEYS_PER_OBJECT = 50;
const JSON_MAX_ITEMS_PER_ARRAY = 50;
const JSON_TRUNCATED_KEY = "__truncated__";
const SENSITIVE_TOOL_KEY_RE = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const TERMINAL_TOOL_RE = /(terminal|bash|shell|exec|command|run_command|powershell|zsh|fish)/i;

const props = defineProps<{ message: Message; highlight?: boolean }>();
const { t } = useI18n();
const toast = useMessage();

const isSystem = computed(() => props.message.role === "system");
const isCommandMessage = computed(() => props.message.role === "command" || props.message.systemType === "command");
const isCommandError = computed(() => props.message.role === "command" && props.message.systemType === "error");
const isStatusCommand = computed(() => isCommandMessage.value && props.message.commandAction === "status");
const statusItems = computed(() => {
  const data = props.message.commandData || {};
  return [
    { key: "status", value: data.isWorking ? "running" : "idle" },
    { key: "source", value: data.source },
    { key: "profile", value: data.profile },
    { key: "model", value: data.model || "-" },
    { key: "queue", value: data.queueLength ?? 0 },
    { key: "run", value: data.runId || "-" },
  ];
});

type DisplayContentFile = {
  type: 'image' | 'file'
  name: string
  path?: string
  url?: string
}

type LegacyToolCallText = {
  toolName: string
  argumentsText: string
}

type LegacyToolCallDisplay = LegacyToolCallText & {
  displayName: string
  preview: string
  terminal: boolean
}

const RAW_TOOL_BLOCK_RE = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/gi
const RAW_TOOL_PARAM_RE = /<parameter=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/parameter>/gi
const RAW_TOOL_TRAILING_RE = /<\/tool_call>/gi
const RAW_TOOL_PARTIAL_RE = /(?:<tool_call>\s*)?<function=[A-Za-z0-9_.:-]+>[\s\S]*$/i

function parseLegacyToolCallText(content: string): LegacyToolCallText | null {
  const match = content.trim().match(/^\[Calling tool:\s*([^\]\s]+)(?:\s+with arguments:\s*([\s\S]*?))?\]\s*$/i)
  if (!match) return null
  return {
    toolName: match[1] || "tool",
    argumentsText: match[2]?.trim() || "",
  }
}

function decodeToolMarkup(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function parseRawToolCalls(content: string): LegacyToolCallText[] {
  const calls: LegacyToolCallText[] = []
  const source = content || ""
  let blockMatch: RegExpExecArray | null
  RAW_TOOL_BLOCK_RE.lastIndex = 0

  while ((blockMatch = RAW_TOOL_BLOCK_RE.exec(source)) !== null) {
    const toolName = blockMatch[1] || "tool"
    const body = blockMatch[2] || ""
    const params: Record<string, string> = {}
    let paramMatch: RegExpExecArray | null
    RAW_TOOL_PARAM_RE.lastIndex = 0

    while ((paramMatch = RAW_TOOL_PARAM_RE.exec(body)) !== null) {
      const key = paramMatch[1] || "value"
      params[key] = decodeToolMarkup(paramMatch[2]?.trim() || "")
    }

    calls.push({
      toolName,
      argumentsText: Object.keys(params).length > 0
        ? JSON.stringify(params)
        : decodeToolMarkup(body.trim()),
    })
  }

  return calls
}

function stripRawToolCallBlocks(content: string, streaming = false): string {
  let cleaned = (content || "")
    .replace(RAW_TOOL_BLOCK_RE, "")
    .replace(RAW_TOOL_TRAILING_RE, "")

  if (streaming) {
    cleaned = cleaned.replace(RAW_TOOL_PARTIAL_RE, "")
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").trim()
}

function getBlockText(block: any): string {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'input_text') {
    return typeof block.text === 'string' ? block.text : ''
  }
  return ''
}

function getImageUrlFromBlock(block: any): string | null {
  if (!block || typeof block !== 'object') return null
  if (block.type !== 'input_image' && block.type !== 'image_url') return null
  const raw = block.image_url
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return null
}

function imageNameFromDataUrl(url: string, index: number): string {
  const match = url.match(/^data:image\/([^;,]+)/i)
  const ext = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png'
  return `image-${index + 1}.${ext}`
}

function parseContentBlocks(content: string): Array<ContentBlock | Record<string, unknown>> | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const parse = (value: string) => {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as Array<ContentBlock | Record<string, unknown>>
      : null
  }

  try {
    return parse(trimmed)
  } catch {
    // Hermes Agent stored some multimodal user messages via Python str(list),
    // e.g. [{'type': 'text'}, {'type': 'image_url', ...}]. Convert that
    // legacy repr into JSON for display only.
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/'/g, '"'),
      )
    } catch {
      return null
    }
  }
}

// Parse ContentBlock[] from JSON string
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  return parseContentBlocks(content);
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
    .map(block => getBlockText(block))
    .filter(Boolean)
    .join('\n');
});

const assistantDisplayContent = computed(() =>
  stripTerminalActionBlocks(props.message.content || '', !!props.message.isStreaming),
);

const assistantSanitizedContent = computed(() =>
  stripRawToolCallBlocks(assistantDisplayContent.value, !!props.message.isStreaming),
);

// Extract files from ContentBlock[]
const contentFiles = computed<DisplayContentFile[] | null>(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.flatMap<DisplayContentFile>((block, index) => {
    if (block.type === 'image') {
      return [{
        type: 'image' as const,
        name: String((block as any).name || `image-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)
    }
    if (block.type === 'file') {
      return [{
        type: 'file' as const,
        name: String((block as any).name || `file-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)
    }
    const imageUrl = getImageUrlFromBlock(block)
    if (imageUrl?.startsWith('data:image/')) {
      return [{
        type: 'image' as const,
        name: imageNameFromDataUrl(imageUrl, index),
        url: imageUrl,
      }]
    }
    return []
  });
});

// Generate download URL with auth token
function getDownloadUrl(path: string, name: string): string {
	const token = getApiKey();
	const base = `/api/hermes/download?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
	return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

function getContentFileUrl(file: DisplayContentFile): string {
  if (file.url) return file.url
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

const toolExpanded = ref(false);
const previewUrl = ref<string | null>(null);

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const speech = useGlobalSpeech();
const voiceSettings = useVoiceSettings();
const { dispatchRawTerminalAction } = useTerminalActions();
const executedTerminalActions = new Set<string>();

// Copy entire bubble content
const copyableContent = computed(() => {
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  if (props.message.role === 'assistant' && parseLegacyToolCallText(content)) return null
  const visibleContent = props.message.role === 'assistant'
    ? stripRawToolCallBlocks(stripTerminalActionBlocks(content), !!props.message.isStreaming)
    : content
  if (!visibleContent.trim()) return null
  return visibleContent
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

const assistantThinkingDisplayBody = computed(() =>
  stripRawToolCallBlocks(stripTerminalActionBlocks(parsedThinking.value.body || '', !!props.message.isStreaming), !!props.message.isStreaming),
);

function processTerminalActions(content: string) {
  if (props.message.role !== 'assistant' || !props.message.isStreaming) return

  for (const jsonString of extractTerminalActionBlocks(content)) {
    if (executedTerminalActions.has(jsonString)) continue
    executedTerminalActions.add(jsonString)

    dispatchRawTerminalAction(jsonString, {
      source: 'assistant-stream',
      messageId: props.message.id,
    })
  }
}

watchEffect(() => {
  processTerminalActions(props.message.content || '')
})

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

type ToolSummaryItem = {
  key: string;
  value: string;
  redacted?: boolean;
};

type ToolPayloadSummary = {
  items: ToolSummaryItem[];
  note?: string;
  redacted: boolean;
  parsed: boolean;
};

type ToolPayload = {
  full: string;
  display: string;
  language?: string;
};

function isToolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateInline(value: string, limit = TOOL_SUMMARY_STRING_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function redactToolText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, () => {
      redacted = true;
      return "Bearer [redacted]";
    })
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|cookie|credential)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      (_match, prefix) => {
        redacted = true;
        return `${prefix}[redacted]`;
      },
    );

  return {
    text: truncateInline(text),
    redacted,
  };
}

function summarizeToolValue(
  value: unknown,
  keyHint = "",
  depth = 0,
): { value: string; redacted: boolean } {
  if (SENSITIVE_TOOL_KEY_RE.test(keyHint)) {
    return { value: "[redacted]", redacted: true };
  }

  if (typeof value === "string") {
    const redacted = redactToolText(value);
    return { value: redacted.text || "-", redacted: redacted.redacted };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value), redacted: false };
  }
  if (value === null || value === undefined) {
    return { value: "-", redacted: false };
  }
  if (Array.isArray(value)) {
    if (depth > 0 || value.length === 0) {
      return { value: `${value.length} items`, redacted: false };
    }
    let redacted = false;
    const preview = value.slice(0, 3).map((item, index) => {
      const summary = summarizeToolValue(item, `${keyHint}.${index}`, depth + 1);
      redacted = redacted || summary.redacted;
      return summary.value;
    });
    return {
      value: `${value.length} items${preview.length ? ` · ${preview.join(" · ")}` : ""}`,
      redacted,
    };
  }
  if (isToolRecord(value)) {
    const count = Object.keys(value).length;
    if (depth > 0) return { value: `${count} fields`, redacted: false };
    return { value: `${count} fields`, redacted: false };
  }

  return { value: String(value), redacted: false };
}

function parseToolPayload(raw?: string): { value: unknown; parsed: boolean } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  try {
    return { value: JSON.parse(trimmed), parsed: true };
  } catch {
    return { value: trimmed, parsed: false };
  }
}

function truncateLongString(value: string, marker: string): string {
  return value.length > JSON_STRING_DISPLAY_LIMIT
    ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + "\n" + marker
    : value;
}

function truncateJsonValue(value: unknown, marker: string): unknown {
  let nodeCount = 0;
  const seen = new WeakSet<object>();

  function stringifyLength(candidate: unknown): number {
    return JSON.stringify(candidate, null, 2).length;
  }

  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1;
    if (nodeCount > JSON_MAX_NODES) return marker;

    if (typeof current === "string") return truncateLongString(current, marker);
    if (current === null || typeof current !== "object") return current;

    if (seen.has(current)) return `[Circular ${marker}]`;
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY);
      for (let i = 0; i < maxItems; i += 1) {
        const remaining = current.length - i;
        result.push(visit(current[i], depth + 1));
        if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
          result.pop();
          result.push(`${marker}: ${remaining} more items`);
          seen.delete(current);
          return result;
        }
      }
      if (current.length > maxItems) {
        result.push(`${marker}: ${current.length - maxItems} more items`);
      }
      seen.delete(current);
      return result;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT);
    for (let i = 0; i < maxKeys; i += 1) {
      const [key, val] = entries[i];
      const remaining = entries.length - i;
      result[key] = visit(val, depth + 1);
      if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
        delete result[key];
        result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`;
        seen.delete(current);
        return result;
      }
    }
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`;
    }
    seen.delete(current);
    return result;
  }

  const truncated = visit(value, 0);
  if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated;
  return { [JSON_TRUNCATED_KEY]: marker };
}

function formatToolPayload(raw?: string): ToolPayload {
  if (!raw) return { full: "", display: "" };

  try {
    const parsed = JSON.parse(raw);
    const full = JSON.stringify(parsed, null, 2);
    const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
      ? JSON.stringify(truncateJsonValue(parsed, t("chat.truncated")), null, 2)
      : full;
    return { full, display, language: "json" };
  } catch {
    return {
      full: raw,
      display: raw.length > TOOL_PAYLOAD_DISPLAY_LIMIT
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

function summarizeToolPayload(raw?: string): ToolPayloadSummary {
  const parsed = parseToolPayload(raw);
  if (!parsed) {
    return { items: [], redacted: false, parsed: false };
  }

  if (!parsed.parsed) {
    const summary = summarizeToolValue(parsed.value, "output");
    return {
      items: [{ key: "output", value: summary.value, redacted: summary.redacted }],
      note: summary.redacted ? "secured" : undefined,
      redacted: summary.redacted,
      parsed: false,
    };
  }

  if (Array.isArray(parsed.value)) {
    const summary = summarizeToolValue(parsed.value, "items");
    return {
      items: [
        { key: "type", value: "list" },
        { key: "items", value: summary.value, redacted: summary.redacted },
      ],
      note: parsed.value.length > 3 ? t("chat.truncated") : undefined,
      redacted: summary.redacted,
      parsed: true,
    };
  }

  if (!isToolRecord(parsed.value)) {
    const summary = summarizeToolValue(parsed.value, "value");
    return {
      items: [{ key: "value", value: summary.value, redacted: summary.redacted }],
      redacted: summary.redacted,
      parsed: true,
    };
  }

  const entries = Object.entries(parsed.value);
  let redacted = false;
  const items = entries.slice(0, TOOL_SUMMARY_MAX_ITEMS).map(([key, value]) => {
    const summary = summarizeToolValue(value, key);
    redacted = redacted || summary.redacted;
    return {
      key,
      value: summary.value,
      redacted: summary.redacted,
    };
  });
  const omitted = Math.max(0, entries.length - items.length);
  const notes = [
    omitted > 0 ? `+${omitted} ${t("chat.truncated")}` : "",
    redacted ? "secured" : "",
  ].filter(Boolean);

  return {
    items,
    note: notes.join(" · ") || undefined,
    redacted,
    parsed: true,
  };
}

const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

const isTerminalTool = computed(() =>
  TERMINAL_TOOL_RE.test(props.message.toolName || ""),
);

const toolDisplayName = computed(() => {
  if (isTerminalTool.value) return "Terminal";
  return props.message.toolName || "Tool";
});

const toolArgsSummary = computed(() => summarizeToolPayload(props.message.toolArgs));
const toolResultSummary = computed(() => summarizeToolPayload(props.message.toolResult));
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult));

const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);

const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(formattedToolArgs.value, toolArgsPayload.value.language);
});

const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(formattedToolResult.value, toolResultPayload.value.language);
});

const hasToolDetails = computed(
  () => !!(props.message.toolArgs || props.message.toolResult),
);

const toolPreviewText = computed(() => {
  if (props.message.toolPreview) {
    return truncateInline(redactToolText(props.message.toolPreview).text, TOOL_PREVIEW_LIMIT);
  }
  const firstItem = toolArgsSummary.value.items[0] || toolResultSummary.value.items[0];
  if (!firstItem) return "";
  return truncateInline(`${firstItem.key}: ${firstItem.value}`, TOOL_PREVIEW_LIMIT);
});

const legacyToolCalls = computed<LegacyToolCallDisplay[]>(() => {
  if (props.message.role !== "assistant") return [];
  const parsedCalls = [
    ...parseRawToolCalls(assistantDisplayContent.value || ""),
    ...(
      parseLegacyToolCallText(assistantSanitizedContent.value || "")
        ? [parseLegacyToolCallText(assistantSanitizedContent.value || "") as LegacyToolCallText]
        : []
    ),
  ];

  return parsedCalls.map((parsed) => {
    const terminal = TERMINAL_TOOL_RE.test(parsed.toolName);
    const summary = summarizeToolPayload(parsed.argumentsText);
    const firstItem = summary.items[0];
    return {
      ...parsed,
      terminal,
      displayName: terminal ? "Terminal" : parsed.toolName,
      preview: firstItem ? truncateInline(`${firstItem.key}: ${firstItem.value}`, TOOL_PREVIEW_LIMIT) : "Tool call pending",
    };
  });
});

const assistantRenderableContent = computed(() =>
  parseLegacyToolCallText(assistantSanitizedContent.value || "") ? "" : assistantSanitizedContent.value,
);

function formatToolDuration(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

// 语音播放相关
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放
  if (props.message.role !== 'assistant') return false
  if (!copyableContent.value) return false
  // OpenAI / Custom / Edge / MiMo 不依赖浏览器 Web Speech API
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') return true
  return speech.isSupported
})

const isPlayingThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

const isPausedThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

function handleSpeechToggle() {
  if (!canPlaySpeech.value) {
    return
  }
  const content = copyableContent.value || props.message.content || ''

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
      rate: speedToEdgeRate(voiceSettings.edgeRate.value),
      pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
    })
    return
  }

  // MiMo TTS 模式
  if (voiceSettings.provider.value === 'mimo') {
    const apiKey = voiceSettings.mimoApiKey.value
    if (!apiKey) {
      console.warn('[MessageItem] MiMo TTS API Key 为空')
      return
    }
    speech.mimoToggle(props.message.id, content, {
      baseUrl: voiceSettings.mimoBaseUrl.value,
      apiKey,
      model: voiceSettings.mimoModel.value,
      voice: voiceSettings.mimoVoice.value,
      voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
      stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
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
      const content = stripRawToolCallBlocks(stripTerminalActionBlocks(customEvent.detail.content || props.message.content || ''))
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
          rate: speedToEdgeRate(voiceSettings.edgeRate.value),
          pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        })
      } else if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        if (apiKey) {
          speech.mimoPlay(props.message.id, content, {
            baseUrl: voiceSettings.mimoBaseUrl.value,
            apiKey,
            model: voiceSettings.mimoModel.value,
            voice: voiceSettings.mimoVoice.value,
            voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
            stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
          })
        }
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
        :class="{ expandable: hasToolDetails, terminal: isTerminalTool }"
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
        <span class="tool-name">{{ toolDisplayName }}</span>
        <span
          v-if="toolPreviewText && !toolExpanded"
          class="tool-preview"
          >{{ toolPreviewText }}</span
        >
        <span
          v-if="message.toolDuration && message.toolStatus !== 'running'"
          class="tool-duration"
          >{{ formatToolDuration(message.toolDuration) }}</span
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
        <div v-if="toolArgsSummary.items.length" class="tool-detail-section" data-copy-source="tool-args">
          <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
          <div class="tool-summary-grid">
            <span
              v-for="item in toolArgsSummary.items"
              :key="`args-${item.key}`"
              class="tool-summary-item"
              :class="{ redacted: item.redacted }"
            >
              <span class="tool-summary-key">{{ item.key }}</span>
              <span class="tool-summary-value">{{ item.value }}</span>
            </span>
          </div>
          <div v-if="toolArgsSummary.note" class="tool-summary-note">
            {{ toolArgsSummary.note }}
          </div>
          <div v-if="formattedToolArgs" class="tool-detail-code-block" v-html="renderedToolArgs"></div>
        </div>
        <div v-if="toolResultSummary.items.length" class="tool-detail-section" data-copy-source="tool-result">
          <div class="tool-detail-label">{{ t("chat.result") }}</div>
          <div class="tool-summary-grid">
            <span
              v-for="item in toolResultSummary.items"
              :key="`result-${item.key}`"
              class="tool-summary-item"
              :class="{ redacted: item.redacted }"
            >
              <span class="tool-summary-key">{{ item.key }}</span>
              <span class="tool-summary-value">{{ item.value }}</span>
            </span>
          </div>
          <div v-if="toolResultSummary.note" class="tool-summary-note">
            {{ toolResultSummary.note }}
          </div>
          <div v-if="formattedToolResult" class="tool-detail-code-block" v-html="renderedToolResult"></div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="msg-body">
        <img
          v-if="message.role === 'assistant'"
          src="/logo.png"
          alt="Aurora"
          class="msg-avatar"
        />
        <div class="msg-content" :class="message.role">
          <div
            class="message-bubble"
            :class="{
              system: isSystem,
              command: isCommandMessage,
              'command-error': isCommandError,
              'streaming-terminal': message.role === 'assistant' && message.isStreaming,
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
            }"
          >
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
              v-if="assistantThinkingDisplayBody && message.role === 'assistant' && !legacyToolCalls.length"
              :content="assistantThinkingDisplayBody"
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
                        :src="getContentFileUrl(file)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getContentFileUrl(file)"
                      />
                    </template>
                    <template v-else>
                      <div
                        class="msg-attachment-file"
                        @click="file.path && downloadFile(file.path, file.name).catch(err => toast.error(err.message || t('download.downloadFailed')))"
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
            <div
              v-if="message.role === 'assistant' && legacyToolCalls.length"
              class="legacy-tool-stack"
            >
              <div
                v-for="(toolCall, index) in legacyToolCalls"
                :key="`${toolCall.toolName}-${index}`"
                class="legacy-tool-line"
                :class="{ terminal: toolCall.terminal }"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m4 7 6 5-6 5" />
                  <path d="M12 19h8" />
                </svg>
                <span class="legacy-tool-name">{{ toolCall.displayName }}</span>
                <span class="legacy-tool-preview">{{ toolCall.preview }}</span>
              </div>
            </div>
            <MarkdownRenderer
              v-if="message.role === 'assistant' && assistantRenderableContent && !assistantThinkingDisplayBody"
              :content="assistantRenderableContent"
            />
            <span
              v-if="message.role === 'assistant' && message.isStreaming && (assistantRenderableContent || assistantThinkingDisplayBody)"
              class="typing-cursor"
              aria-hidden="true"
            ></span>

            <!-- Render system message content -->
            <MarkdownRenderer
              v-if="message.role === 'system' && message.content && !isCommandMessage"
              :content="message.content"
            />
            <div v-if="isStatusCommand" class="command-result command-status">
              <span class="command-result-icon">/</span>
              <div class="command-status-grid">
                <span
                  v-for="item in statusItems"
                  :key="item.key"
                  class="command-status-item"
                >
                  <span class="command-status-key">{{ item.key }}</span>
                  <span class="command-status-value">{{ item.value }}</span>
                </span>
              </div>
            </div>
            <div v-else-if="isCommandMessage && message.content" class="command-result">
              <span class="command-result-icon">/</span>
              <MarkdownRenderer :content="message.content" />
            </div>

            <span v-if="message.isStreaming && (!message.content || (message.role === 'assistant' && !assistantRenderableContent && !assistantThinkingDisplayBody))" class="streaming-dots">
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
      border: 1px solid rgba(255, 255, 255, 0.48);
      border-radius: 20px 20px 8px 20px;
      color: #182033;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.26)),
        rgba(224, 232, 255, 0.32);
      box-shadow: 0 16px 42px rgba(91, 116, 180, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(22px);
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
      width: 38px;
      height: 38px;
      flex-shrink: 0;
      margin-top: 2px;
      border: 1px solid rgba(255, 255, 255, 0.72);
      border-radius: 16px;
      box-shadow: 0 14px 28px rgba(99, 102, 241, 0.12);
    }

    .message-bubble {
      border: 1px solid rgba(255, 255, 255, 0.52);
      border-radius: 20px 20px 20px 8px;
      color: #182033;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.44), rgba(255, 255, 255, 0.18)),
        rgba(255, 255, 255, 0.26);
      box-shadow: 0 16px 42px rgba(91, 116, 180, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.62);
      backdrop-filter: blur(22px);
    }
  }

  &.tool {
    align-items: flex-start;
  }

  &.system {
    align-items: flex-start;
  }

  &.command {
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
  padding: 11px 15px;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  border-radius: 20px;
  max-width: 100%;
  position: relative;
  box-sizing: border-box;

  &.system {
    border: 1px solid rgba(var(--warning-rgb), 0.28);
    border-left: 3px solid $warning;
    border-radius: 16px;
    max-width: 80%;
    background: rgba(var(--warning-rgb), 0.08);
  }

  &.command {
    border-left: none;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
    background: rgba(255, 255, 255, 0.24);
    backdrop-filter: blur(18px);
    color: $text-secondary;
    max-width: min(100%, 960px);
    padding: 8px 10px;
  }

  &.command-error {
    border-color: rgba(var(--warning-rgb), 0.28);
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }

  &.streaming-terminal {
    border-left: 2px solid #ff4fd8;
    background:
      linear-gradient(90deg, rgba(255, 79, 216, 0.1) 0%, rgba(0, 245, 255, 0.035) 42%, transparent 100%),
      $msg-assistant-bg;
    box-shadow:
      0 0 0 1px rgba(255, 79, 216, 0.14),
      0 0 18px rgba(0, 245, 255, 0.08);
  }
}

.command-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;

  :deep(.markdown-body) {
    min-width: 0;
  }

  :deep(.markdown-body p) {
    margin: 0;
  }
}

.command-status {
  align-items: center;
}

.command-status-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}

.command-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.035);
  line-height: 1.4;
}

.command-status-key {
  color: $text-muted;
  font-size: 11px;
}

.command-status-value {
  color: $text-primary;
  font-family: $font-code;
  font-size: 11px;
}

.command-result-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1;
  margin-top: 2px;
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

  &.terminal {
    width: fit-content;
    border: 1px solid rgba(0, 245, 255, 0.18);
    background: linear-gradient(135deg, rgba(0, 245, 255, 0.08), rgba(255, 79, 216, 0.06));
    color: rgba(20, 36, 58, 0.74);
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

.legacy-tool-stack {
  display: grid;
  width: fit-content;
  max-width: min(620px, 100%);
  gap: 6px;
}

.legacy-tool-line {
  display: flex;
  align-items: center;
  width: fit-content;
  max-width: min(620px, 100%);
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid rgba(255, 255, 255, 0.46);
  border-radius: 14px;
  color: $text-secondary;
  background: rgba(255, 255, 255, 0.24);
  backdrop-filter: blur(18px);
  font-size: 12px;
  line-height: 1.3;

  &.terminal {
    border-color: rgba(239, 68, 68, 0.22);
    color: $text-primary;
    background: rgba(239, 68, 68, 0.08);
  }
}

.legacy-tool-name {
  flex: 0 0 auto;
  color: $text-primary;
  font-family: $font-code;
  font-weight: 700;
}

.legacy-tool-preview {
  min-width: 0;
  overflow: hidden;
  color: $text-secondary;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-duration {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
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

.tool-summary-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tool-summary-item {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: min(100%, 520px);
  overflow: hidden;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.11);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.58);
  color: $text-secondary;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);

  &.redacted {
    border-color: rgba(var(--warning-rgb), 0.18);
    background: rgba(var(--warning-rgb), 0.06);
  }
}

.tool-summary-key,
.tool-summary-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-summary-key {
  flex: 0 0 auto;
  padding: 4px 7px;
  border-right: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
}

.tool-summary-value {
  padding: 4px 8px;
  font-size: 11px;
}

.tool-summary-note {
  margin-top: 4px;
  color: $text-muted;
  font-size: 10px;
}

.tool-detail-code-block {
  margin-top: 6px;

  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: rgba(0, 0, 0, 0.02);
  }

  :deep(code.hljs) {
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
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

.typing-cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  margin-left: 4px;
  vertical-align: text-bottom;
  background: #00f5ff;
  box-shadow:
    0 0 8px rgba(0, 245, 255, 0.8),
    0 0 14px rgba(0, 245, 255, 0.28);
  animation: terminal-cursor-blink 0.8s step-end infinite;
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

@keyframes terminal-cursor-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
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

:global(.dark) .message {
  &.user .message-bubble,
  &.assistant .message-bubble {
    border-color: rgba(255, 255, 255, 0.12);
    color: rgba(241, 245, 249, 0.94);
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.035)),
      rgba(15, 23, 42, 0.34);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  &.assistant .msg-avatar {
    border-color: rgba(255, 255, 255, 0.16);
    box-shadow: 0 14px 30px rgba(99, 102, 241, 0.18);
  }

  .legacy-tool-line {
    border-color: rgba(255, 255, 255, 0.12);
    color: rgba(226, 232, 240, 0.8);
    background: rgba(15, 23, 42, 0.36);
  }
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
