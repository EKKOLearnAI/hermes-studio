<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { NButton, NTooltip, NSwitch, NModal, NInputNumber, NPopselect, useMessage } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
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

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()
const message = useMessage()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

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

    if (textareaHeight.value === null) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`
    }
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
  if (!query) return bridgeCommands.value
  return bridgeCommands.value.filter((command) => {
    const name = command.name.toLowerCase()
    const insertText = command.insertText?.toLowerCase()
    return name.startsWith(query) || insertText?.startsWith(query)
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

function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return
  // 如果当前是 auto，用实际 clientHeight 作为起始值
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    // 往上拖 (deltaY < 0) → 高度增加
    const newHeight = startHeight - deltaY
    textareaHeight.value = Math.max(20, Math.min(400, Math.round(newHeight)))
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
})

// 监听变化并保存
watch(autoPlaySpeech, (value) => {
  localStorage.setItem('autoPlaySpeech', String(value))
  // 通知 chat store
  chatStore.setAutoPlaySpeech(value)
})

watch(inputText, (value) => {
  saveDraftForActiveSession(value)
})

watch(() => chatStore.activeSession?.id, () => {
  loadDraftForActiveSession()
})

watch(
  () => [chatStore.activeSession?.profile, profilesStore.activeProfileName],
  () => {
    skillsLoadedKey = ''
    skillCategories.value = []
  },
)

const canSend = computed(() => inputText.value.trim() || attachments.value.length > 0)

function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function updateSlashState() {
  if (!isBridgeSession.value) {
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
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 100) + 'px'
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
    <!-- Top bar: attach + auto play speech + context info -->
    <div class="input-top-bar">
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton quaternary size="tiny" @click="handleAttachClick" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
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
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              quaternary
              size="tiny"
              circle
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
            </NButton>
          </template>
          {{ t('chat.reasoningEffort.tooltip') }}: {{ reasoningEffortLabel }}
        </NTooltip>
      </NPopselect>

      <div class="auto-play-speech-switch">
        <NTooltip trigger="hover">
          <template #trigger>
            <div class="switch-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          </template>
          {{ t('chat.autoPlaySpeech') }}
        </NTooltip>
        <NSwitch
          size="small"
          v-model:value="autoPlaySpeech"
          :round="false"
        />
      </div>

      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            quaternary
            size="tiny"
            class="tool-trace-toggle"
            :class="{ active: toolTraceVisible }"
            :aria-label="toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls')"
            @click="toggleToolTraceVisible"
          >
            <svg class="tool-trace-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a4.5 4.5 0 0 0-5.8 5.8L3.5 17.5a2.1 2.1 0 0 0 3 3l5.4-5.4a4.5 4.5 0 0 0 5.8-5.8l-3 3-3-3 3-3z"/>
            </svg>
          </NButton>
        </template>
        {{ toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls') }}
      </NTooltip>

      <span v-if="showContextUsage" class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
        {{ formatTokens(totalTokens) }} /
        <NTooltip trigger="hover">
          <template #trigger>
            <span class="context-limit-editable" @click="handleEditContextLimit">
              {{ formatTokens(contextLength) }}
            </span>
          </template>
          <span>{{ t('chat.contextClickToEdit') }}</span>
        </NTooltip>
        · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
      </span>
      <div v-if="showContextUsage" class="context-bar">
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
      <div class="resize-handle" @mousedown="startResize"></div>
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
          v-if="chatStore.isStreaming"
          size="small"
          type="error"
          :disabled="chatStore.isAborting"
          @click="chatStore.stopStreaming()"
        >
          {{ t('chat.stop') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!canSend"
          @click="handleSend"
        >
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </template>
          {{ t('chat.send') }}
        </NButton>
      </div>
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
  padding: 12px 20px 16px;
  border-top: 1px solid $border-color;
  flex-shrink: 0;
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
}

.auto-play-speech-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 0 8px;
  border-left: 1px solid $border-light;
  margin-left: 4px;

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
  margin-left: -4px;
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

.reasoning-effort-button {
  &.active {
    color: #4caf50;
  }
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

@media (max-width: 768px) {
  .input-top-bar {
    gap: 5px;
  }

  .context-info {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
    line-height: 14px;
    margin-right: 10px;
  }

  .context-bar {
    width: 42px;
    flex-shrink: 0;
  }
}

.attachment-previews {
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
  align-items: center;
  gap: 10px;
  background-color: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 10px 12px;
  position: relative;
  transition: border-color $transition-fast, background-color $transition-fast;

  &:focus-within {
    border-color: $accent-primary;
  }

  .dark & {
    background-color: #333333;
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
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: $text-primary;
  font-family: $font-ui;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 400px;
  min-height: 20px;
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
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
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

// Drag-over state
.input-wrapper.drag-over {
  border-color: var(--accent-info);
  border-style: dashed;
  background-color: rgba(var(--accent-info-rgb), 0.04);
}
</style>
