<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import MarkdownRenderer from '../chat/MarkdownRenderer.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import {
    copyTextToClipboard,
    extractUnifiedDiffPayload,
    handleCodeBlockCopyClick,
    inferStructuredLanguage,
    renderHighlightedCodeBlock,
} from '../chat/highlight'
import { parseThinking, countThinkingChars } from '@/utils/thinking-parser'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { speedToEdgeRate, hzToEdgePitch } from '@/utils/ttsHelpers'
import { getDownloadUrl } from '@/api/hermes/download'
import { formatChatTimestamp } from '@/utils/chat-timestamp'
import type { ChatMessage, RoomAgent, MemberInfo } from '@/api/hermes/group-chat'

const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000
const JSON_STRING_DISPLAY_LIMIT = 200
const JSON_MAX_DEPTH = 6
const JSON_MAX_NODES = 1000
const JSON_MAX_KEYS_PER_OBJECT = 50
const JSON_MAX_ITEMS_PER_ARRAY = 50
const JSON_TRUNCATED_KEY = '__truncated__'

const props = defineProps<{
    message: ChatMessage
    agents: RoomAgent[]
    members?: MemberInfo[]
    currentUserId?: string
}>()

const { t } = useI18n()
const toast = useMessage()
const profilesStore = useProfilesStore()
const speech = useGlobalSpeech()
const voiceSettings = useVoiceSettings()
const previewUrl = ref<string | null>(null)
const isAgent = computed(() => {
    return props.agents.some(a => a.agentId === props.message.senderId || a.name === props.message.senderName)
})

const isAgentError = computed(() => {
    if (props.message.role !== 'assistant') return false
    if (props.message.finish_reason === 'error') return true
    return /^Error:\s*/i.test(props.message.content || '')
})

const isSelf = computed(() => {
    return !!props.currentUserId && props.message.senderId === props.currentUserId
})

const agentInfo = computed(() => {
    return props.agents.find(a => a.agentId === props.message.senderId || a.name === props.message.senderName)
})

const timeStr = computed(() => formatChatTimestamp(props.message.timestamp))

const avatarProfileName = computed(() => agentInfo.value?.profile || props.message.senderName || props.message.senderId)
const avatarProfile = computed(() => profilesStore.profiles.find(profile => profile.name === agentInfo.value?.profile))

// 找当前消息发送者在 members 里的记录
const memberInfo = computed(() => {
    if (isAgent.value) return null
    return props.members?.find(m =>
        m.userId === props.message.senderId ||
        m.name === props.message.senderName
    ) || null
})

// 解析 member 的 avatar JSON
const memberAvatar = computed(() => {
    const av = memberInfo.value?.avatar
    if (!av) return null
    try {
        const parsed = typeof av === 'string' ? JSON.parse(av) : av
        if (parsed && parsed.type === 'image' && parsed.dataUrl) return parsed
    } catch {}
    return null
})

// 当前消息要显示的头像(profile / member / fallback)
const currentAvatar = computed(() => {
    if (isAgent.value) {
        return avatarProfile.value?.avatar ?? null
    }
    return memberAvatar.value
})

// 给 ProfileAvatar 的 name seed
const avatarDisplayName = computed(() => {
    if (isAgent.value) return avatarProfileName.value
    return props.message.senderName || props.message.senderId || 'user'
})

const mentionNames = computed(() => ['all', ...props.agents.map(a => a.name).filter(Boolean)])
const parsedThinking = computed(() => parseThinking(props.message.content || '', { streaming: !!props.message.isStreaming }))
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0))
const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking)
const thinkingFullText = computed(() => {
    const parts: string[] = []
    if (props.message.reasoning) parts.push(props.message.reasoning)
    parts.push(...parsedThinking.value.segments)
    if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending)
    return parts.join('\n\n')
})
const thinkingCharCount = computed(() => {
    let count = countThinkingChars(parsedThinking.value)
    if (props.message.reasoning) count += props.message.reasoning.length
    return count
})
const thinkingStreamingNow = computed(() => {
    if (!props.message.isStreaming) return false
    if (parsedThinking.value.pending !== null) return true
    if (hasReasoningField.value && !props.message.content) return true
    return false
})
const thinkingOverride = ref<boolean | null>(null)
const thinkingExpanded = computed(() => {
    if (thinkingStreamingNow.value) return true
    if (thinkingOverride.value !== null) return thinkingOverride.value
    return false
})
const assistantBody = computed(() => parsedThinking.value.body || props.message.content || '')
const contentBlocks = computed(() => {
    const content = props.message.content || ''
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
    try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
})
const renderedAttachments = computed(() => {
    if (props.message.attachments?.length) return props.message.attachments
    const blocks = contentBlocks.value
    if (!blocks) return []
    return blocks.flatMap((block: any, index: number) => {
        if (block?.type !== 'image' && block?.type !== 'file') return []
        const path = String(block.path || '')
        if (!path) return []
        const name = String(block.name || `${block.type}-${index + 1}`)
        return [{
            id: `${props.message.id}_attachment_${index}`,
            name,
            type: block.type === 'image' ? String(block.media_type || 'image/*') : String(block.media_type || 'application/octet-stream'),
            size: 0,
            url: getDownloadUrl(normalizeLocalFilePath(path), name),
        }]
    })
})
const hasAttachments = computed(() => renderedAttachments.value.length > 0)
const displayBody = computed(() => {
    if (props.message.role !== 'user') return assistantBody.value
    const blocks = contentBlocks.value
    if (!blocks) return assistantBody.value
    return blocks
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
})
const copyableContent = computed(() => {
    if (isToolMessage.value) return null
    const content = displayBody.value || ''
    return content.trim() ? content : null
})

const toolExpanded = ref(false)
const isToolMessage = computed(() => props.message.role === 'tool')
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs))
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true))
const hasToolDetails = computed(() => !!(toolArgsPayload.value.full || toolResultPayload.value.full))
const fullToolArgs = computed(() => toolArgsPayload.value.full)
const formattedToolArgs = computed(() => toolArgsPayload.value.display)
const fullToolResult = computed(() => toolResultPayload.value.full)
const formattedToolResult = computed(() => toolResultPayload.value.display)
const renderedToolArgs = computed(() => formattedToolArgs.value ? renderToolPayload(formattedToolArgs.value, toolArgsPayload.value.language) : '')
const renderedToolResult = computed(() => formattedToolResult.value ? renderToolPayload(formattedToolResult.value, toolResultPayload.value.language) : '')
const canPlaySpeech = computed(() => {
    if (props.message.role !== 'assistant') return false
    if (!assistantBody.value.trim()) return false
    if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') return true
    return speech.isSupported
})
const isPlayingThisMessage = computed(() => {
    if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
        return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
    }
    return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})
const isPausedThisMessage = computed(() => {
    if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
        return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
    }
    return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

type ToolPayload = {
    full: string
    display: string
    language?: string
}

function truncateLongString(value: string, marker: string): string {
    return value.length > JSON_STRING_DISPLAY_LIMIT ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + '\n' + marker : value
}

function truncateJsonValue(value: unknown, marker: string): unknown {
    let nodeCount = 0
    const seen = new WeakSet<object>()

    function stringifyLength(candidate: unknown): number {
        return JSON.stringify(candidate, null, 2).length
    }

    function visit(current: unknown, depth: number): unknown {
        nodeCount += 1
        if (nodeCount > JSON_MAX_NODES) return marker
        if (typeof current === 'string') return truncateLongString(current, marker)
        if (current === null || typeof current !== 'object') return current
        if (seen.has(current)) return `[Circular ${marker}]`
        if (depth >= JSON_MAX_DEPTH) return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`

        seen.add(current)

        if (Array.isArray(current)) {
            const result: unknown[] = []
            const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY)
            for (let i = 0; i < maxItems; i += 1) {
                const remaining = current.length - i
                result.push(visit(current[i], depth + 1))
                if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
                    result.pop()
                    result.push(`${marker}: ${remaining} more items`)
                    seen.delete(current)
                    return result
                }
            }
            if (current.length > maxItems) result.push(`${marker}: ${current.length - maxItems} more items`)
            seen.delete(current)
            return result
        }

        const entries = Object.entries(current as Record<string, unknown>)
        const result: Record<string, unknown> = {}
        const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT)
        for (let i = 0; i < maxKeys; i += 1) {
            const [key, val] = entries[i]
            const remaining = entries.length - i
            result[key] = visit(val, depth + 1)
            if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
                delete result[key]
                result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`
                seen.delete(current)
                return result
            }
        }
        if (entries.length > maxKeys) result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`
        seen.delete(current)
        return result
    }

    const truncated = visit(value, 0)
    if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated
    return { [JSON_TRUNCATED_KEY]: marker }
}

function normalizeToolPayload(raw: unknown): string {
    if (raw === null || raw === undefined || raw === '') return ''
    if (typeof raw === 'string') return raw
    try {
        const serialized = JSON.stringify(raw)
        if (serialized !== undefined) return serialized
    } catch {
        // Fall through to String(raw) for non-serializable runtime payloads.
    }
    return String(raw)
}

function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
    const text = normalizeToolPayload(raw)
    if (!text) return { full: '', display: '' }

    const shouldParseJson = typeof raw !== 'string' || /^[\[{]/.test(text.trim())
    if (shouldParseJson) {
        try {
            const parsed = JSON.parse(text)
            const full = JSON.stringify(parsed, null, 2)
            const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null
            if (extractedDiff) {
                return {
                    full,
                    display: extractedDiff,
                    language: 'diff',
                }
            }
            const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
                ? JSON.stringify(truncateJsonValue(parsed, t('chat.truncated')), null, 2)
                : full
            return { full, display, language: 'json' }
        } catch {
            // Fall through to text rendering for non-JSON strings.
        }
    }

    const language = inferStructuredLanguage(text)
    return {
        full: text,
        display: language === 'diff' || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT ? text : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + '\n' + t('chat.truncated'),
        language,
    }
}


function renderToolPayload(content: string, language?: string): string {
    return renderHighlightedCodeBlock(content, language, t('common.copy'), {
        maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
        formatDiffFoldLabel: (hiddenCount) => t('chat.unchangedLines', { count: hiddenCount }),
    })
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLElement>('[data-copy-code="true"]')
    if (!button) return
    event.preventDefault()

    const source = button.closest<HTMLElement>('[data-copy-source]')?.dataset.copySource
    if (source === 'tool-args' && fullToolArgs.value) {
        const ok = await copyTextToClipboard(fullToolArgs.value)
        if (ok) toast.success(t('common.copied'))
        else toast.error(t('chat.copyFailed'))
        return
    }
    if (source === 'tool-result' && fullToolResult.value) {
        const ok = await copyTextToClipboard(fullToolResult.value)
        if (ok) toast.success(t('common.copied'))
        else toast.error(t('chat.copyFailed'))
        return
    }

    const copyResult = await handleCodeBlockCopyClick(event)
    if (copyResult) toast.success(t('common.copied'))
    else if (copyResult === false) toast.error(t('chat.copyFailed'))
}

function handleAutoplayTtsError(err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    console.warn('[GroupMessageItem] TTS autoplay failed:', err)
}

function playSpeech(content: string, autoplay = false) {
    if (!content.trim()) return
    if (voiceSettings.provider.value === 'openai') {
        if (!voiceSettings.openaiBaseUrl.value) return
        const options = {
            provider: 'openai' as const,
            baseUrl: voiceSettings.openaiBaseUrl.value,
            apiKey: voiceSettings.openaiApiKey.value,
            model: voiceSettings.openaiModel.value,
            voice: voiceSettings.openaiVoice.value,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'custom') {
        if (!voiceSettings.customUrl.value) return
        const options = {
            provider: 'custom' as const,
            baseUrl: voiceSettings.customUrl.value,
            apiKey: voiceSettings.customApiKey.value || undefined,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'edge') {
        const options = {
            provider: 'edge' as const,
            baseUrl: '/api/tts/proxy',
            voice: voiceSettings.edgeVoice.value,
            rate: speedToEdgeRate(voiceSettings.edgeRate.value),
            pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        const options = {
            baseUrl: voiceSettings.mimoBaseUrl.value,
            apiKey: apiKey || undefined,
            authMode: voiceSettings.mimoAuthMode.value,
            model: voiceSettings.mimoModel.value,
            voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' as const : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' as const : 'preset' as const,
            voice: voiceSettings.mimoVoice.value,
            voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
            voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
            voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
            stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }
        if (autoplay) void speech.mimoPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.mimoToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'doubao') {
        const options = {
            provider: 'doubao' as const,
            baseUrl: voiceSettings.doubaoBaseUrl.value,
            model: voiceSettings.doubaoModel.value,
            voice: voiceSettings.doubaoVoice.value,
            stylePrompt: voiceSettings.doubaoStylePrompt.value || undefined,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'webspeech') {
        speech.toggleBrowser(props.message.id, content, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
        })
        return
    }
    if (autoplay) speech.enqueue(props.message.id, content)
    else speech.toggle(props.message.id, content)
}

function handleSpeechToggle() {
    if (canPlaySpeech.value) playSpeech(assistantBody.value)
}

async function copyBubbleContent() {
    const text = copyableContent.value
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (ok) toast.success(t('chat.copiedBubble'))
    else toast.error(t('chat.copyFailed'))
}

function isImage(type: string): boolean {
    return type.startsWith('image/')
}

function normalizeLocalFilePath(path: string): string {
    return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

let autoPlayHandler: ((e: Event) => void) | null = null

onMounted(() => {
    autoPlayHandler = (e: Event) => {
        const event = e as CustomEvent<{ messageId: string; content: string }>
        if (event.detail?.messageId === props.message.id && canPlaySpeech.value) {
            playSpeech(event.detail.content || assistantBody.value, true)
        }
    }
    window.addEventListener('auto-play-speech', autoPlayHandler)
})

onBeforeUnmount(() => {
    if (autoPlayHandler) window.removeEventListener('auto-play-speech', autoPlayHandler)
    if (speech.currentMessageId.value === props.message.id || speech.currentCustomMessageId.value === props.message.id) speech.stop()
})
</script>

<template>
    <div v-if="isToolMessage" class="group-message tool-message">
        <div class="avatar">
            <ProfileAvatar :name="avatarDisplayName" :avatar="currentAvatar" :size="36" />
        </div>

        <div class="msg-body">
            <div class="msg-header">
                <span class="sender-name">{{ message.senderName }}</span>
                <span v-if="isAgent && agentInfo?.description" class="agent-desc">{{ agentInfo.description }}</span>
            </div>
            <div class="tool-line" :class="{ expandable: hasToolDetails }" @click="hasToolDetails && (toolExpanded = !toolExpanded)">
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
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="tool-icon">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span class="tool-name">{{ message.toolName || message.tool_name || 'tool' }}</span>
                <span v-if="message.toolPreview && !toolExpanded" class="tool-preview">{{ message.toolPreview }}</span>
                <span v-if="message.toolStatus === 'running'" class="tool-spinner"></span>
                <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{ t('chat.error') }}</span>
            </div>
            <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
                <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
                    <div class="tool-detail-label">{{ t('chat.arguments') }}</div>
                    <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
                </div>
                <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
                    <div class="tool-detail-label">{{ t('chat.result') }}</div>
                    <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
                </div>
            </div>
            <span class="msg-time">{{ timeStr }}</span>
        </div>
    </div>
    <div v-else class="group-message" :class="{ agent: isAgent, self: isSelf }">
        <!-- Avatar -->
        <div class="avatar">
            <ProfileAvatar :name="avatarDisplayName" :avatar="currentAvatar" :size="36" />
        </div>

        <div class="msg-body">
            <div class="msg-header">
                <span class="sender-name">{{ message.senderName }}</span>
                <span v-if="isAgent && agentInfo?.description" class="agent-desc">{{ agentInfo.description }}</span>
            </div>
            <div
                class="msg-content"
                :class="{
                    'agent-content': isAgent,
                    'agent-error': isAgentError,
                    'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
                }"
            >
                <div v-if="hasAttachments" class="msg-attachments">
                    <div
                        v-for="att in renderedAttachments"
                        :key="att.id"
                        class="msg-attachment"
                        :class="{ image: isImage(att.type) }"
                    >
                        <img v-if="isImage(att.type)" :src="att.url" :alt="att.name" class="msg-attachment-thumb" @click="previewUrl = att.url" />
                        <a v-else class="msg-attachment-file" :href="att.url" :title="t('download.downloadFile')">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span class="att-name">{{ att.name }}</span>
                            <span class="att-size">{{ formatSize(att.size) }}</span>
                        </a>
                    </div>
                </div>
                <div v-if="hasThinking" class="thinking-block" :class="{ expanded: thinkingExpanded }">
                    <div class="thinking-header" @click="thinkingOverride = !thinkingExpanded">
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
                            {{ thinkingStreamingNow ? t('chat.thinkingInProgress') : t('chat.thinkingLabel') }}
                        </span>
                        <span class="thinking-meta">· {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}</span>
                    </div>
                    <div v-if="thinkingExpanded" class="thinking-body">
                        <MarkdownRenderer :content="thinkingFullText" />
                    </div>
                </div>
                <MarkdownRenderer v-if="displayBody" :content="displayBody" :mention-names="mentionNames" />
                <span v-if="message.isStreaming && !displayBody" class="streaming-dots">
                    <span></span><span></span><span></span>
                </span>
            </div>
            <div class="message-meta">
                <button
                    v-if="canPlaySpeech"
                    class="speech-bubble-btn"
                    :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
                    :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
                    @click="handleSpeechToggle"
                >
                    <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button
                    v-if="copyableContent"
                    class="copy-bubble-btn"
                    :title="t('chat.copyBubble')"
                    @click="copyBubbleContent"
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
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
        <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-message {
    display: flex;
    gap: 10px;
    padding: 2px 0;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;

    &.self {
        flex-direction: row-reverse;

        .msg-body {
            align-items: flex-end;
        }

        .msg-header {
            flex-direction: row-reverse;
        }
    }

    &.agent .msg-content.agent-content {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.agent .msg-content.agent-error {
        color: $error;
        background-color: rgba(var(--error-rgb), 0.06);
        border: 1px solid rgba(var(--error-rgb), 0.2);

        :deep(.markdown-body),
        :deep(.markdown-body p),
        :deep(.markdown-body li),
        :deep(.markdown-body strong),
        :deep(.markdown-body code) {
            color: $error;
        }
    }

    &.self .msg-content {
        background-color: rgba(var(--accent-primary-rgb), 0.1);
    }
}

.tool-message {
    align-items: flex-start;
}

.tool-line {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: $radius-sm;
    color: $text-muted;
    font-size: 11px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;

    &.expandable {
        cursor: pointer;

        &:hover {
            background: rgba(0, 0, 0, 0.03);
        }
    }
}

.tool-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
        transform: rotate(90deg);
    }
}

.tool-icon,
.tool-chevron {
    flex: 0 0 auto;
    opacity: 0.75;
}

.tool-name {
    flex: 0 1 auto;
    min-width: 0;
    font-family: $font-code;
    color: $text-muted;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-preview {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(400px, 100%);
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
    margin-bottom: 2px;
    color: $text-muted;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
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

.avatar {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin-top: 2px;
    overflow: hidden;
    border-radius: 8px;
}

.msg-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 85%;
    box-sizing: border-box;
}

.msg-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;

    .sender-name {
        font-size: 13px;
        font-weight: 600;
        color: $text-primary;
    }

    .agent-desc {
        font-size: 11px;
        color: $text-muted;
        font-style: italic;
    }
}

.msg-time,
.message-time {
    font-size: 12px;
    color: var(--text-muted);
    opacity: 0.6;
    user-select: none;
}

.message-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 4px;
    opacity: 0;
    transition: opacity 0.15s ease;

    .group-message:hover & {
        opacity: 1;
    }

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

.msg-content {
    padding: 10px 14px;
    font-size: 14px;
    line-height: 1.65;
    color: $text-primary;
    border-radius: 10px;
    background-color: $msg-user-bg;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    word-break: break-word;
    overflow-wrap: anywhere;

    &.speech-playing {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
        animation: rainbow-glow 4s linear infinite;
    }

    &.agent-error {
        color: $error;
        background-color: rgba(var(--error-rgb), 0.06);
        border: 1px solid rgba(var(--error-rgb), 0.2);

        :deep(.markdown-body),
        :deep(.markdown-body p),
        :deep(.markdown-body li),
        :deep(.markdown-body strong),
        :deep(.markdown-body code) {
            color: $error;
        }
    }

    :deep(.mention-highlight) {
        color: #409eff;
        font-weight: 600;
        cursor: default;
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
    background-color: $bg-secondary;
    border: 1px solid $border-color;

    &.image {
        width: 96px;
        height: 96px;
    }
}

.msg-attachment-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    cursor: zoom-in;
}

.msg-attachment-file {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 140px;
    max-width: 220px;
    padding: 8px 10px;
    color: $text-secondary;
    text-decoration: none;

    .att-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
    }

    .att-size {
        font-size: 11px;
        color: $text-muted;
    }
}

.image-preview-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.82);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.image-preview-img {
    max-width: min(96vw, 1400px);
    max-height: 92vh;
    object-fit: contain;
    border-radius: 6px;
    cursor: zoom-out;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
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

        :deep(p) {
            margin: 0.3em 0;
        }
    }
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
</style>
