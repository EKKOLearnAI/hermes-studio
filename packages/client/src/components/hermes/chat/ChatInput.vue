<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { NButton, NTooltip, NModal, NInputNumber, NPopselect, NDropdown, useMessage, type DropdownOption } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import VoiceDialogueControls from './VoiceDialogueControls.vue'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceDialogue } from '@/composables/useVoiceDialogue'
import { transcribeSpeech } from '@/api/hermes/stt'
import type { StoredSttProvider } from '@/api/hermes/stt-settings'
import { useSttSettings } from '@/composables/useSttSettings'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'
import { BRIDGE_SESSION_COMMAND_DEFINITIONS } from '@/utils/hermes/bridge-session-commands'
import { clampChatInputHeight, isMobileChatInputViewport } from '@/utils/chat-input-height'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()
const message = useMessage()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

const props = withDefaults(defineProps<{
  modelLabel?: string
}>(), {
  modelLabel: '',
})

const emit = defineEmits<{
  modelClick: []
}>()

const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: '' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
])
const currentReasoningEffort = computed<string>(() =>
  chatStore.activeSession?.reasoningEffort || ''
)
const reasoningEffortLabel = computed<string>(() => {
  const v = currentReasoningEffort.value
  if (!v) return t('chat.reasoningEffort.defaultLabel')
  const opt = reasoningEffortOptions.value.find(o => o.value === v)
  return opt?.label || v
})
function onReasoningEffortChange(value: string | null | undefined) {
  const sid = chatStore.activeSessionId
  if (!sid) return
  chatStore.setSessionReasoningEffort(sid, value || '')
}

function handleModelButtonClick() {
  emit('modelClick')
}

const compactModelLabel = computed(() => {
  const label = props.modelLabel || t('models.selectModel')
  const parts = label.split('/').filter(Boolean)
  return parts[parts.length - 1] || label
})

const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v1'
type DraftMap = Record<string, string>
const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const commandDropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const isMobileViewport = ref(typeof window !== 'undefined' ? isMobileChatInputViewport(window.innerWidth) : false)
const manualTextareaResize = ref(false)
const speech = useGlobalSpeech()
const micRecorder = useMicRecorder({
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})
const sttSettings = useSttSettings()
const browserRecognition = useBrowserSpeechRecognition({
  messages: {
    unsupported: t('chat.voiceInput.browserSpeechUnsupported'),
    failed: t('chat.voiceInput.browserSpeechFailed'),
    failedWithReason: (reason) => t('chat.voiceInput.browserSpeechFailedWithReason', { error: reason }),
  },
})
const activeVoiceCaptureMode = ref<'browser' | 'backend' | null>(null)
const configuredTextareaHeight = computed(() =>
  isMobileViewport.value ? null : clampChatInputHeight(settingsStore.display.chat_input_height),
)

type SlashCommandOption = {
  name: string
  args: string
  description: string
  insertText?: string
  key: string
  opensSkillPicker?: boolean
}

function normalizeVoiceTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function backendTranscribeOptions(): {
  provider: StoredSttProvider
  language?: string
  prompt?: string
} {
  if (sttSettings.provider.value === 'custom') {
    return {
      provider: 'custom',
      language: sttSettings.customLanguage.value.trim() || undefined,
      prompt: sttSettings.customPrompt.value.trim() || undefined,
    }
  }

  if (sttSettings.provider.value === 'doubao') {
    return {
      provider: 'doubao',
    }
  }

  return {
    provider: 'openai',
    language: sttSettings.openaiLanguage.value.trim() || undefined,
    prompt: sttSettings.openaiPrompt.value.trim() || undefined,
  }
}

function browserCaptureLanguage() {
  return sttSettings.openaiLanguage.value.trim() || sttSettings.customLanguage.value.trim() || ''
}

function insertVoiceTranscriptIntoInput(text: string) {
  const normalizedTranscript = normalizeVoiceTranscript(text)
  if (!normalizedTranscript) return

  const el = textareaRef.value
  const currentValue = inputText.value
  const selectionStart = el?.selectionStart ?? currentValue.length
  const selectionEnd = el?.selectionEnd ?? selectionStart
  const before = currentValue.slice(0, selectionStart)
  const after = currentValue.slice(selectionEnd)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}${normalizedTranscript}${suffix}${after}`
  const nextCursorPosition = before.length + prefix.length + normalizedTranscript.length

  inputText.value = nextValue
  slashActive.value = false

  nextTick(() => {
    const textarea = textareaRef.value
    if (!textarea) return

    textarea.focus()
    textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)
    autoSizeTextarea(textarea)
  })
}

const voiceDialogue = useVoiceDialogue({
  transcribe: async (audio) => {
    const { provider, language, prompt } = backendTranscribeOptions()
    return transcribeSpeech({ audio, provider, language, prompt })
  },
  sendMessage: async (text) => {
    insertVoiceTranscriptIntoInput(text)
  },
  stopOutputAudio: () => speech.stop(true),
})
const voiceDialogueTranscript = computed(() => {
  if (activeVoiceCaptureMode.value !== 'browser' || voiceDialogue.status.value !== 'capturing') {
    return voiceDialogue.transcript.value
  }

  return normalizeVoiceTranscript([
    browserRecognition.transcript.value,
    browserRecognition.partialTranscript.value,
  ].filter(Boolean).join(' '))
})
const shouldShowBrowserRecognitionError = computed(() =>
  sttSettings.provider.value === 'browser' || activeVoiceCaptureMode.value === 'browser',
)
const voiceDialogueError = computed(() =>
  voiceDialogue.error.value?.message
  ?? (shouldShowBrowserRecognitionError.value ? browserRecognition.error.value?.message : null)
  ?? micRecorder.state.value.error?.message
  ?? null,
)

const bridgeCommands = computed<SlashCommandOption[]>(() =>
  BRIDGE_SESSION_COMMAND_DEFINITIONS.map(command => ({
    key: command.key,
    name: command.name,
    args: command.argsKey ? t(command.argsKey) : command.args || '',
    description: t(command.descriptionKey),
    insertText: command.insertText,
    opensSkillPicker: command.opensSkillPicker,
  }))
)

const slashActive = ref(false)
const slashQuery = ref('')
const slashActiveIndex = ref(0)
const skillCategories = ref<SkillCategory[]>([])
const showSkillPicker = ref(false)
const skillSearch = ref('')
const skillPickerLoading = ref(false)
let skillsLoadedKey = ''
let skillsLoadRequest: Promise<void> | null = null
const isBridgeSession = computed(() => chatStore.activeSession?.source === 'cli')
const isForkCommandSession = computed(() => !!chatStore.activeSession && chatStore.activeSession.source !== 'coding_agent')
const skillPickerItems = computed(() => {
  const byName = new Map<string, SkillInfo>()
  for (const category of skillCategories.value) {
    for (const skill of category.skills || []) {
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].map(skill => {
    const commandName = skillCommandName(skill.name)
    return {
      key: `skill:${commandName}`,
      name: skill.name,
      commandName,
      description: skill.description || skill.name,
    }
  })
})
const filteredBridgeCommands = computed(() => {
  const query = slashQuery.value.trim().toLowerCase()
  const commands = isBridgeSession.value
    ? bridgeCommands.value
    : isForkCommandSession.value
      ? bridgeCommands.value.filter(command => command.name === 'fork')
      : []
  if (!query) return commands
  return commands.filter((command) => {
    const name = command.name.toLowerCase()
    const insertText = command.insertText?.toLowerCase()
    const description = command.description.toLowerCase()
    return name.startsWith(query) || insertText?.startsWith(query) || description.includes(query)
  })
})
const filteredSkillPickerItems = computed(() => {
  const query = skillSearch.value.trim().toLowerCase()
  if (!query) return skillPickerItems.value
  return skillPickerItems.value.filter(skill =>
    skill.name.toLowerCase().includes(query)
    || skill.commandName.includes(query)
    || skill.description.toLowerCase().includes(query),
  )
})

function skillCommandName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function currentSkillsKey() {
  return chatStore.activeSession?.profile || profilesStore.activeProfileName || 'default'
}

async function loadSkills() {
  if (!isBridgeSession.value) return
  const key = currentSkillsKey()
  if (skillsLoadedKey === key || skillsLoadRequest) return skillsLoadRequest
  skillsLoadRequest = (async () => {
    try {
      const data = await fetchSkills(key)
      if (currentSkillsKey() !== key) return
      skillCategories.value = data.categories || []
      skillsLoadedKey = key
    } catch {
      if (currentSkillsKey() !== key) return
      skillCategories.value = []
      skillsLoadedKey = key
    } finally {
      skillsLoadRequest = null
    }
  })()
  return skillsLoadRequest
}

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null) // null = auto

function syncViewport() {
  if (typeof window === 'undefined') return
  isMobileViewport.value = isMobileChatInputViewport(window.innerWidth)
}

function resetTextareaHeight() {
  manualTextareaResize.value = false
  applyConfiguredTextareaHeight()
}

function autoSizeTextarea(el: HTMLTextAreaElement | undefined = textareaRef.value) {
  if (!el || textareaHeight.value !== null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 100)}px`
}

function applyConfiguredTextareaHeight() {
  if (manualTextareaResize.value) return

  textareaHeight.value = configuredTextareaHeight.value

  const textarea = textareaRef.value
  if (!textarea) return

  if (textareaHeight.value === null) {
    autoSizeTextarea(textarea)
    return
  }

  textarea.style.height = `${textareaHeight.value}px`
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return
  manualTextareaResize.value = true
  // 如果当前是 auto，用实际 clientHeight 作为起始值
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    // 往上拖 (deltaY < 0) → 高度增加
    const newHeight = startHeight - deltaY
    textareaHeight.value = clampChatInputHeight(newHeight) ?? textareaHeight.value
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// 自动播放语音开关
const autoPlaySpeech = ref(false)
const inputSettingsOptions = computed<DropdownOption[]>(() => [
  {
    label: t('chat.autoPlaySpeech'),
    key: 'autoPlaySpeech',
    icon: () => h('span', {
      class: ['settings-check', { active: autoPlaySpeech.value }],
      'aria-hidden': 'true',
    }, autoPlaySpeech.value ? '✓' : ''),
  },
  {
    label: t('chat.showToolCalls'),
    key: 'toolTrace',
    icon: () => h('span', {
      class: ['settings-check', { active: toolTraceVisible.value }],
      'aria-hidden': 'true',
    }, toolTraceVisible.value ? '✓' : ''),
  },
])

function readDraftMap(): DraftMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getActiveDraftSessionId() {
  return chatStore.activeSessionId || chatStore.activeSession?.id || ''
}

function loadDraftForActiveSession() {
  const sessionId = getActiveDraftSessionId()
  inputText.value = sessionId ? readDraftMap()[sessionId] || '' : ''
}

function saveDraftForActiveSession(value: string) {
  const sessionId = getActiveDraftSessionId()
  if (!sessionId) return
  const drafts = readDraftMap()
  if (value) {
    drafts[sessionId] = value
  } else {
    delete drafts[sessionId]
  }
  if (Object.keys(drafts).length > 0) {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
  } else {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  }
}

// 从 localStorage 读取设置
onMounted(() => {
  loadDraftForActiveSession()
  const saved = localStorage.getItem('autoPlaySpeech')
  if (saved !== null) {
    autoPlaySpeech.value = saved === 'true'
    // 同步到 chat store
    chatStore.setAutoPlaySpeech(autoPlaySpeech.value)
  }
  syncViewport()
  window.addEventListener('resize', syncViewport)
  nextTick(() => {
    applyConfiguredTextareaHeight()
  })
})

// 监听变化并保存
watch(autoPlaySpeech, (value) => {
  localStorage.setItem('autoPlaySpeech', String(value))
  // 通知 chat store
  chatStore.setAutoPlaySpeech(value)
})

function handleInputSettingsSelect(key: string | number) {
  if (key === 'autoPlaySpeech') {
    autoPlaySpeech.value = !autoPlaySpeech.value
    return
  }

  if (key === 'toolTrace') {
    toggleToolTraceVisible()
  }
}

watch(inputText, (value) => {
  saveDraftForActiveSession(value)
})

watch(() => chatStore.activeSession?.id, () => {
  loadDraftForActiveSession()
  nextTick(() => {
    applyConfiguredTextareaHeight()
  })
})

watch(configuredTextareaHeight, () => {
  applyConfiguredTextareaHeight()
})

watch(
  () => [chatStore.activeSession?.profile, profilesStore.activeProfileName],
  () => {
    skillsLoadedKey = ''
    skillCategories.value = []
  },
)

const canSend = computed(() => inputText.value.trim().length > 0 || attachments.value.length > 0)
const sendButtonIsStop = computed(() => chatStore.isStreaming && !canSend.value)

function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function updateSlashState() {
  if (!isBridgeSession.value && !isForkCommandSession.value) {
    slashActive.value = false
    return
  }
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const beforeCursor = inputText.value.slice(0, cursorPos)
  if (!beforeCursor.startsWith('/') || beforeCursor.includes(' ') || beforeCursor.includes('\n')) {
    slashActive.value = false
    return
  }
  slashQuery.value = beforeCursor.slice(1)
  slashActiveIndex.value = 0
  slashActive.value = filteredBridgeCommands.value.length > 0
}

function selectBridgeCommand(command: SlashCommandOption) {
  if (command.opensSkillPicker) {
    slashActive.value = false
    void openSkillPicker()
    return
  }
  inputText.value = `/${command.insertText || command.name} `
  slashActive.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function openSkillPicker() {
  if (!isBridgeSession.value) return
  slashActive.value = false
  skillSearch.value = ''
  showSkillPicker.value = true
  skillPickerLoading.value = true
  try {
    await loadSkills()
  } finally {
    skillPickerLoading.value = false
  }
}

function selectSkill(skill: { commandName: string }) {
  inputText.value = `/skill ${skill.commandName} `
  showSkillPicker.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

// --- Context info ---

const contextLength = ref(256000)
const FALLBACK_CONTEXT = 256000
let contextLengthLoadedKey = ''
let contextLengthRequestKey = ''
let contextLengthRequest: Promise<void> | null = null

// Context length editing
const showContextEditModal = ref(false)
const editingContextLimit = ref(256000)
const isSavingContextLimit = ref(false)
const isCodingAgentSession = computed(() => chatStore.activeSession?.source === 'coding_agent')

async function handleEditContextLimit() {
  if (isCodingAgentSession.value) return
  editingContextLimit.value = contextLength.value
  showContextEditModal.value = true
}

async function saveContextLimit() {
  if (!editingContextLimit.value || editingContextLimit.value <= 0) {
    message.error(t('chat.contextEditInvalid'))
    return
  }

  isSavingContextLimit.value = true
  try {
    const provider = chatStore.activeSession?.provider || appStore.selectedProvider || ''
    const model = chatStore.activeSession?.model || appStore.selectedModel || ''

    if (!provider || !model) {
      message.error(t('chat.contextEditFailed'))
      return
    }

    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    contextLengthLoadedKey = currentContextLengthKey()
    showContextEditModal.value = false
    message.success(t('chat.contextEditSuccess'))
  } catch (err: any) {
    message.error(`${t('chat.contextEditFailed')}: ${err.message || ''}`)
  } finally {
    isSavingContextLimit.value = false
  }
}

function currentContextLengthParams() {
  const activeSession = chatStore.activeSession
  return {
    profile: activeSession?.profile || profilesStore.activeProfileName || undefined,
    provider: activeSession?.provider || undefined,
    model: activeSession?.model || undefined,
  }
}

function currentContextLengthKey() {
  const params = currentContextLengthParams()
  return `${params.profile || ''}|${params.provider || ''}|${params.model || ''}`
}

async function loadContextLength() {
  if (isCodingAgentSession.value) return
  const key = currentContextLengthKey()
  if (key === contextLengthLoadedKey) return
  if (key === contextLengthRequestKey && contextLengthRequest) return contextLengthRequest

  contextLengthRequestKey = key
  contextLengthRequest = (async () => {
    const params = currentContextLengthParams()
    try {
      const value = await fetchContextLength(params.profile, params.provider, params.model)
      if (currentContextLengthKey() !== key) return
      contextLength.value = value
      contextLengthLoadedKey = key
    } catch {
      if (currentContextLengthKey() !== key) return
      contextLength.value = FALLBACK_CONTEXT
      contextLengthLoadedKey = key
    } finally {
      if (contextLengthRequestKey === key) {
        contextLengthRequest = null
        contextLengthRequestKey = ''
      }
    }
  })()
  return contextLengthRequest
}

onMounted(loadContextLength)
watch(
  () => [
    profilesStore.activeProfileName,
    appStore.selectedProvider,
    appStore.selectedModel,
    chatStore.activeSession?.id,
    chatStore.activeSession?.profile,
    chatStore.activeSession?.provider,
    chatStore.activeSession?.model,
    chatStore.activeSession?.source,
  ],
  loadContextLength,
  { flush: 'post' },
)

const totalTokens = computed(() => {
  if (isCodingAgentSession.value) return 0
  const context = chatStore.activeSession?.contextTokens
  if (typeof context === 'number' && Number.isFinite(context) && context > 0) return context
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})
const showContextUsage = computed(() => totalTokens.value > 0)

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

const usagePercent = computed(() =>
  Math.min((totalTokens.value / contextLength.value) * 100, 100),
)

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// --- File attachment helpers ---

function addFile(file: File) {
  if (attachments.value.find(a => a.name === file.name)) return
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const url = URL.createObjectURL(file)
  attachments.value.push({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    file,
  })
}

function addFiles(files: File[]) {
  for (const file of files) addFile(file)
  if (files.length > 0) textareaRef.value?.focus()
}

function handleAttachClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

// --- Paste image ---

function handlePaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imageItems = items.filter(i => i.type.startsWith('image/'))
  if (!imageItems.length) return
  e.preventDefault()
  for (const item of imageItems) {
    const blob = item.getAsFile()
    if (!blob) continue
    const ext = item.type.split('/')[1] || 'png'
    const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type })
    addFiles([file])
  }
}

// --- Drag and drop ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.types.includes('Files')) {
    dragCounter.value++
    isDragging.value = true
  }
}

function handleDragLeave() {
  dragCounter.value--
  if (dragCounter.value <= 0) {
    dragCounter.value = 0
    isDragging.value = false
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter.value = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  addFiles(files)
}

defineExpose({ addFiles })

// --- Send ---

function handleSend() {
  const text = inputText.value.trim()
  if (!text && attachments.value.length === 0) return
  if (isBridgeSession.value && text === '/skill' && attachments.value.length === 0) {
    void openSkillPicker()
    return
  }

  chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined)
  inputText.value = ''
  saveDraftForActiveSession('')
  attachments.value = []
  slashActive.value = false

  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

async function startVoiceCapture() {
  browserRecognition.clearError()
  const { captureId } = await voiceDialogue.beginCapture()
  const useBrowserProvider = sttSettings.provider.value === 'browser'

  activeVoiceCaptureMode.value = useBrowserProvider ? 'browser' : 'backend'

  try {
    if (useBrowserProvider) {
      await browserRecognition.start({ language: browserCaptureLanguage() })
      return
    }

    await micRecorder.start()
  } catch {
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
  }
}

async function stopVoiceCapture() {
  const captureId = voiceDialogue.activeCaptureId.value
  if (!captureId) return

  if (activeVoiceCaptureMode.value === 'browser') {
    let transcript = ''

    try {
      transcript = await browserRecognition.stop()
    } catch {
      activeVoiceCaptureMode.value = null
      voiceDialogue.cancelCapture(captureId)
      return
    }

    activeVoiceCaptureMode.value = null

    try {
      await voiceDialogue.commitTranscript(captureId, transcript)
    } catch {
      // Voice dialogue state already tracks send errors.
    }
    return
  }

  if (micRecorder.state.value.status === 'requesting') {
    micRecorder.cancel()
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  let audio: Blob

  try {
    audio = await micRecorder.stop()
  } catch {
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  activeVoiceCaptureMode.value = null

  if (audio.size <= 0) {
    voiceDialogue.cancelCapture(captureId)
    return
  }

  try {
    await voiceDialogue.transcribeAndSend(captureId, audio)
  } catch {
    // Voice dialogue state already tracks transcription/send errors.
  }
}

function cancelVoiceCapture() {
  if (activeVoiceCaptureMode.value === 'browser') {
    browserRecognition.cancel()
  } else {
    micRecorder.cancel()
  }

  activeVoiceCaptureMode.value = null
  voiceDialogue.cancelCapture()
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateSlashState()
  })
}

function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

function handleKeydown(e: KeyboardEvent) {
  if (slashActive.value && filteredBridgeCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value + 1) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value - 1 + filteredBridgeCommands.value.length) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectBridgeCommand(filteredBridgeCommands.value[slashActiveIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashActive.value = false
      return
    }
  }

  if (e.key !== 'Enter' || e.shiftKey) return
  if (isImeEnter(e)) return

  e.preventDefault()
  handleSend()
}

function handleInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  if (!isComposing.value) updateSlashState()
  // 用户手动拖拽自定义高度时，不覆盖
  if (textareaHeight.value !== null) return
  autoSizeTextarea(el)
}

function handleCommandHover(index: number) {
  slashActiveIndex.value = index
}

function onDocumentMousedown(e: MouseEvent) {
  if (!slashActive.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.slash-command-dropdown') && !target.closest('.input-wrapper')) {
    slashActive.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('resize', syncViewport)
})

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx !== -1) {
    URL.revokeObjectURL(attachments.value[idx].url)
    attachments.value.splice(idx, 1)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isImage(type: string): boolean {
  return type.startsWith('image/')
}
</script>

<template>
  <div class="chat-input-area">
    <!-- Attachment previews -->
    <div v-if="attachments.length > 0" class="attachment-previews">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type) }"
      >
        <template v-if="isImage(att.type)">
          <img :src="att.url" :alt="att.name" class="attachment-thumb" />
        </template>
        <template v-else>
          <div class="attachment-file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ att.name }}</span>
            <span class="file-size">{{ formatSize(att.size) }}</span>
          </div>
        </template>
        <button class="attachment-remove" @click="removeAttachment(att.id)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div
      class="input-wrapper"
      :class="{ 'drag-over': isDragging }"
      @dragover="handleDragOver"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />
      <div
        class="resize-handle"
        :title="t('chat.inputHeightResizeHint')"
        @mousedown="startResize"
        @dblclick="resetTextareaHeight"
      ></div>
      <div v-if="showContextUsage" class="context-usage-row">
        <span class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
          {{ formatTokens(totalTokens) }} /
          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <span class="context-limit-editable" @click="handleEditContextLimit">
                {{ formatTokens(contextLength) }}
              </span>
            </template>
            <span>{{ t('chat.contextClickToEdit') }}</span>
          </NTooltip>
          · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
        </span>
        <div class="context-bar">
          <div
            class="context-bar-fill"
            :class="{
              'context-bar-warn': usagePercent > 60 && usagePercent <= 80,
              'context-bar-danger': usagePercent > 80,
            }"
            :style="{ width: `${usagePercent}%` }"
          />
        </div>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
        :placeholder="t('chat.inputPlaceholder')"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <div class="input-toolbar">
        <!-- Bottom bar: attach + input settings + actions -->
        <div class="input-top-bar">
          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <NButton quaternary size="tiny" @click="handleAttachClick" circle class="toolbar-icon-button">
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.attachFiles') }}
          </NTooltip>

          <NPopselect
            v-if="!isCodingAgentSession"
            :value="currentReasoningEffort"
            :options="reasoningEffortOptions"
            trigger="click"
            @update:value="onReasoningEffortChange"
          >
            <NTooltip trigger="hover" :disabled="isMobileViewport">
              <template #trigger>
                <NButton
                  quaternary
                  size="tiny"
                  class="reasoning-effort-button"
                  :class="{ active: !!currentReasoningEffort }"
                  :aria-label="`${t('chat.reasoningEffort.tooltip')}: ${reasoningEffortLabel}`"
                >
                  <template #icon>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                    </svg>
                  </template>
                  <span class="reasoning-effort-label">{{ reasoningEffortLabel }}</span>
                  <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                </NButton>
              </template>
              {{ t('chat.reasoningEffort.tooltip') }}: {{ reasoningEffortLabel }}
            </NTooltip>
          </NPopselect>

          <NDropdown
            trigger="click"
            :options="inputSettingsOptions"
            :show-arrow="true"
            @select="handleInputSettingsSelect"
          >
            <NTooltip trigger="hover" :disabled="isMobileViewport">
              <template #trigger>
                <NButton
                  quaternary
                  size="tiny"
                  class="input-settings-button"
                  :aria-label="t('sidebar.settings')"
                >
                  <template #icon>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.6.77 1 1.4 1H21a2 2 0 1 1 0 4h-.09c-.63 0-1.2.4-1.51 1Z"/>
                    </svg>
                  </template>
                  <span class="input-settings-label">{{ t('sidebar.settings') }}</span>
                  <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                </NButton>
              </template>
              {{ t('sidebar.settings') }}
            </NTooltip>
          </NDropdown>

          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <NButton
                quaternary
                size="tiny"
                class="input-model-button"
                :title="isMobileViewport ? undefined : props.modelLabel || t('models.selectModel')"
                :aria-label="props.modelLabel || t('models.selectModel')"
                @click="handleModelButtonClick"
              >
                <template #icon>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v4" />
                    <path d="M12 19v4" />
                    <path d="M1 12h4" />
                    <path d="M19 12h4" />
                    <path d="M4.22 4.22l2.83 2.83" />
                    <path d="M16.95 16.95l2.83 2.83" />
                    <path d="M4.22 19.78l2.83-2.83" />
                    <path d="M16.95 7.05l2.83-2.83" />
                  </svg>
                </template>
                <span class="input-model-label">{{ compactModelLabel }}</span>
                <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </NButton>
            </template>
            {{ props.modelLabel || t('models.selectModel') }}
          </NTooltip>

        </div>
        <div class="input-actions">
          <VoiceDialogueControls
            :status="voiceDialogue.status.value"
            :transcript="voiceDialogueTranscript"
            :error="voiceDialogueError"
            :events="voiceDialogue.events.value"
            :on-start="startVoiceCapture"
            :on-stop="stopVoiceCapture"
            :on-cancel="cancelVoiceCapture"
          />
          <NButton
            size="medium"
            type="primary"
            circle
            class="send-button"
            :class="{ 'send-button--stop': sendButtonIsStop }"
            :disabled="sendButtonIsStop ? chatStore.isAborting : !canSend"
            :aria-label="sendButtonIsStop ? 'Stop' : 'Send'"
            @click="sendButtonIsStop ? chatStore.stopStreaming() : handleSend()"
          >
            <template #icon>
              <svg
                v-if="sendButtonIsStop"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
              </svg>
              <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
            </template>
            <span class="visually-hidden">{{ sendButtonIsStop ? t('chat.stop') : t('chat.send') }}</span>
          </NButton>
        </div>
      </div>
      <Transition name="dropdown-fade">
        <div
          v-if="slashActive && filteredBridgeCommands.length > 0"
          ref="commandDropdownRef"
          class="slash-command-dropdown"
        >
          <div
            v-for="(command, i) in filteredBridgeCommands"
            :key="command.key"
            class="slash-command-item"
            :class="{ active: i === slashActiveIndex }"
            @mousedown.prevent="selectBridgeCommand(command)"
            @mouseenter="handleCommandHover(i)"
          >
            <span class="slash-command-name">/{{ command.name }}</span>
            <span v-if="command.args" class="slash-command-args">{{ command.args }}</span>
            <span class="slash-command-desc">{{ command.description }}</span>
          </div>
        </div>
      </Transition>
    </div>

    <NModal
      v-model:show="showSkillPicker"
      :title="t('skills.title')"
      :mask-closable="true"
      preset="card"
      style="width: min(620px, calc(100vw - 32px))"
    >
      <div v-if="showSkillPicker" class="skill-picker-modal">
        <input
          v-model="skillSearch"
          class="skill-picker-search"
          :placeholder="t('skills.searchPlaceholder')"
          type="search"
        />
        <div class="skill-picker-list">
          <div v-if="skillPickerLoading" class="skill-picker-empty">
            {{ t('common.loading') }}
          </div>
          <template v-else>
            <div
              v-for="skill in filteredSkillPickerItems"
              :key="skill.key"
              role="button"
              tabindex="0"
              class="skill-picker-item"
              @click="selectSkill(skill)"
              @keydown.enter.prevent="selectSkill(skill)"
              @keydown.space.prevent="selectSkill(skill)"
            >
              <div class="skill-picker-command">/skill {{ skill.commandName }}</div>
              <div class="skill-picker-name">{{ skill.name }}</div>
              <div class="skill-picker-desc">{{ skill.description }}</div>
            </div>
          </template>
          <div v-if="!skillPickerLoading && filteredSkillPickerItems.length === 0" class="skill-picker-empty">
            {{ skillSearch ? t('skills.noMatch') : t('skills.noSkills') }}
          </div>
        </div>
      </div>
    </NModal>

    <!-- Context Length Edit Modal -->
    <NModal
      v-model:show="showContextEditModal"
      :title="t('chat.contextEditTitle')"
      :mask-closable="true"
      preset="card"
      style="width: 400px"
    >
      <div class="context-edit-content">
        <p style="margin-bottom: 16px; color: #666;">
          {{ t('chat.contextEditDesc') }}
        </p>
        <NInputNumber
          v-model:value="editingContextLimit"
          :min="1000"
          :max="10000000"
          :step="1000"
          :show-button="false"
          :placeholder="t('chat.contextEditPlaceholder')"
          style="width: 100%"
        >
          <template #suffix>
            <span style="color: #999;">tokens</span>
          </template>
        </NInputNumber>
        <div style="margin-top: 12px; font-size: 12px; color: #999;">
          {{ t('chat.contextEditHint') }}
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <NButton @click="showContextEditModal = false" :disabled="isSavingContextLimit">
            {{ t('chat.contextEditCancel') }}
          </NButton>
          <NButton type="primary" @click="saveContextLimit" :loading="isSavingContextLimit">
            {{ t('chat.contextEditSave') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-input-area {
  position: relative;
  z-index: 80;
  padding: 8px 20px 14px;
  border-top: 0;
  background-color: $bg-card;
  flex-shrink: 0;
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  padding: 0;
}

.auto-play-speech-switch {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 0 0 2px;
  margin-left: 0;

  .switch-label {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: #999999;
    font-size: 12px;

    svg {
      opacity: 1;
    }
  }

  :deep(.n-switch),
  :deep(.n-switch__rail) {
    margin-right: 0;
  }
}

.tool-trace-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999999;
  width: 24px;
  min-width: 24px;
  height: 22px;
  margin-left: 0;
  padding: 0;
  background: transparent !important;
  opacity: 1;

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }

  .tool-trace-icon {
    display: block;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
  }

  &.active {
    color: #999999;
    opacity: 1;
  }

  &:hover {
    color: #999999;
    opacity: 1;
  }
}

.input-settings-button {
  color: $text-secondary;
  border-radius: 999px;
  padding: 0 7px 0 6px;

  :deep(.n-button__content) {
    gap: 4px;
  }

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }
}

.input-model-button {
  color: $text-secondary;
  border-radius: 999px;
  max-width: 190px;
  padding: 0 4px 0 6px;

  :deep(.n-button__content) {
    gap: 4px;
    min-width: 0;
  }

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }
}

.input-model-label {
  display: inline-block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
  white-space: nowrap;
}

.reasoning-effort-button {
  color: $text-secondary;
  border-radius: 999px;
  padding: 0 4px 0 6px;

  &.active {
    color: #4caf50;
  }

  :deep(.n-button__content) {
    gap: 4px;
    min-width: 0;
  }
}

.reasoning-effort-label {
  display: inline-block;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
  white-space: nowrap;
}

.toolbar-chevron {
  flex: 0 0 12px;
  color: $text-muted;
}

.context-usage-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  position: absolute;
  top: 9px;
  right: 14px;
  z-index: 1;
  min-width: 0;
  max-width: calc(100% - 28px);
  padding: 0;
  pointer-events: auto;
}

.context-info {
  font-size: 11px;
  color: $text-muted;
  min-width: 0;
  white-space: nowrap;

  &.context-warning {
    color: #e8a735;
  }
}

.context-limit-editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: all 0.2s ease;
  padding: 0 2px;

  &:hover {
    border-bottom-color: $text-muted;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 2px;
  }
}

.context-bar {
  width: 60px;
  height: 4px;
  margin-left: -4px;
  background: rgba(128, 128, 128, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(128, 128, 128, 0.3), rgba(128, 128, 128, 0.6));
  border-radius: 2px;
  transition: width 0.3s ease;

  &.context-bar-warn {
    background: linear-gradient(90deg, #c98a1a, #e8a735);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #c43a2a, #e85d4a);
  }
}

.dark .context-info {
  color: rgba(255, 255, 255, 0.68);

  &.context-warning {
    color: #f0bc58;
  }
}

.dark .context-limit-editable {
  color: rgba(255, 255, 255, 0.8);

  &:hover {
    border-bottom-color: rgba(255, 255, 255, 0.58);
    background: rgba(255, 255, 255, 0.08);
  }
}

.dark .context-bar {
  background: rgba(255, 255, 255, 0.18);
}

.dark .context-bar-fill {
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.72));

  &.context-bar-warn {
    background: linear-gradient(90deg, #d99d35, #f0bc58);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #d95445, #ff7a68);
  }
}

@media (max-width: 768px) {
  .chat-input-area {
    --voice-overlay-mobile-bottom-offset: 146px;
    padding: 8px 12px 12px;
  }

  .input-top-bar {
    gap: 5px;
  }

  .reasoning-effort-label,
  .auto-play-speech-switch {
    display: none;
  }

  .input-model-button {
    min-width: 35px;
    max-width: 35px;
    padding: 0 4px 0 6px;
  }

  .input-model-label {
    display: none;
  }

  .input-settings-button {
    min-width: 36px;
    padding: 0 4px 0 6px;

    :deep(.n-button__content) {
      gap: 2px;
    }

    :deep(.n-button__icon) {
      margin: 0;
    }
  }

  .input-settings-label {
    display: none;
  }

  .context-info {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
    line-height: 14px;
  }

  .context-bar {
    width: 42px;
    flex-shrink: 0;
  }
}

.attachment-previews {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 10px;
}

.attachment-preview {
  position: relative;
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: $bg-secondary;
  border: 1px solid $border-color;

  &.image {
    width: 64px;
    height: 64px;
  }
}

.attachment-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 12px;
  min-width: 80px;
  max-width: 140px;
  color: $text-secondary;

  .file-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .file-size {
    font-size: 10px;
    color: $text-muted;
  }
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity $transition-fast;

  .attachment-preview:hover & {
    opacity: 1;
  }
}

.file-input-hidden {
  display: none;
}

.input-wrapper {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  min-height: 150px;
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: 18px;
  padding: 22px 12px 9px;
  position: relative;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
  transition: border-color $transition-fast, box-shadow $transition-fast;

  &:focus-within {
    border-color: rgba(var(--text-primary-rgb), 0.22);
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.11);
  }

  &.drag-over {
    border-color: $accent-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.04);
  }

  .dark & {
    background-color: $bg-card;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  }
}

.resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 2;

  &:hover {
    background: rgba($accent-primary, 0.15);
    border-radius: 4px;
  }
}

.input-textarea {
  display: block;
  flex: 1;
  width: 100%;
  background: none;
  border: none;
  outline: none;
  color: $text-primary;
  font-family: $font-ui;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 400px;
  min-height: 24px;
  padding: 0;
  overflow-y: auto;

  @media (max-width: 768px) {
    font-size: 16px;
  }

  &::placeholder {
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.input-actions {
  display: flex;
  gap: 7px;
  flex-shrink: 0;
  align-items: center;
}

.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}

.toolbar-icon-button {
  color: $text-muted;
}

.send-button {
  width: 30px !important;
  min-width: 30px !important;
  height: 30px !important;
  padding: 0 !important;
  border: 0 !important;
  box-shadow: none !important;

  :deep(.n-button__icon) {
    margin: 0 !important;
  }

  :deep(.n-button__content) {
    display: none;
  }

  :deep(.n-button__border),
  :deep(.n-button__state-border),
  :deep(.n-button__ripple),
  :deep(.n-base-wave) {
    display: none;
  }

  &:disabled {
    color: var(--text-on-overlay);
    background-color: #9f9f9f;
    opacity: 1;
  }
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.slash-command-dropdown {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  max-height: 240px;
  overflow-y: auto;
  background: $bg-primary;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  z-index: 20;
  padding: 4px;

  .dark & {
    background: #2a2a2a;
  }
}

.slash-command-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  cursor: pointer;
  min-height: 36px;

  &.active,
  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }

}

.slash-command-name {
  font-family: $font-code;
  font-size: 13px;
  color: $accent-primary;
  white-space: nowrap;
}

.slash-command-args {
  font-family: $font-code;
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;
}

.slash-command-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-size: 12px;
}

.skill-picker-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-picker-search {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  outline: none;
  font-family: $font-ui;
  font-size: 13px;

  &:focus {
    border-color: $accent-primary;
  }
}

.skill-picker-list {
  max-height: min(420px, 52vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-picker-item {
  display: block;
  flex: 0 0 76px;
  width: 100%;
  height: 76px;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-primary;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  outline: none;

  &:focus-visible,
  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.5);
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.skill-picker-command {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: $font-code;
  font-size: 12px;
  line-height: 16px;
  color: $accent-primary;
  white-space: nowrap;
}

.skill-picker-name,
.skill-picker-desc {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-picker-name {
  margin-top: 3px;
  font-size: 13px;
  line-height: 18px;
  color: $text-primary;
}

.skill-picker-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 16px;
  color: $text-secondary;
}

.skill-picker-empty {
  padding: 18px 10px;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

@media (max-width: 768px) {
  .skill-picker-item {
    height: 76px;
  }

  .input-wrapper {
    min-height: 118px;
  }

  .input-textarea::placeholder {
    font-size: 13px;
    line-height: 1.35;
  }
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

</style>
