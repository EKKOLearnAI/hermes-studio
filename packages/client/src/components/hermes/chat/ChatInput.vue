<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'
import { useAuroraWorkingMemoryStore } from '@/stores/hermes/working-memory'
import { fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSkills, type SkillInfo } from '@/api/hermes/skills'
import { fetchPlugins, type HermesPluginInfo } from '@/api/hermes/plugins'
import { getAuroraToolCommandInput } from '@/services/hermes/aurora/intent-parsers'
import { NButton, NTooltip, NSwitch, NModal, NInputNumber, useMessage } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import { useTerminalState } from '@/composables/useTerminalState'

withDefaults(defineProps<{
  launcher?: boolean
}>(), {
  launcher: false,
})

const emit = defineEmits<{
  submitted: []
}>()

const chatStore = useChatStore()
const auroraCommanderStore = useAuroraCommanderStore()
const vibeCodingStore = useVibeCodingStore()
const workingMemoryStore = useAuroraWorkingMemoryStore()
const i18n = useI18n()
const t = i18n.t
const activeLocale = computed(() => String(i18n.locale?.value || 'zh-TW'))
const message = useMessage()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()
const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const commandDropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const { activeTicker, getTickerLiveMetrics } = useTerminalState()
type ComposerMode = 'intent' | 'build' | 'automate'
const composerMode = ref<ComposerMode>('intent')
const isBuildMode = computed(() => composerMode.value === 'build')
const isAutomateMode = computed(() => composerMode.value === 'automate')

const quantContextHint = computed(() => {
  if (!activeTicker.value) return ''
  const metrics = getTickerLiveMetrics(activeTicker.value)
  const signal = metrics?.signal || metrics?.action
  const score = typeof metrics?.score === 'number' ? `Score ${metrics.score}` : ''
  return [t('aurora.omnibar.quantWatching'), activeTicker.value, signal, score].filter(Boolean).join(' · ')
})
const workingMemoryHint = computed(() =>
  workingMemoryStore.contextLockEnabled ? workingMemoryStore.contextLabel : '',
)

const trimmedIntent = computed(() => inputText.value.trim())
const composerModeLabels = computed<Record<ComposerMode, string>>(() => ({
  intent: t('aurora.omnibar.ask'),
  build: t('aurora.omnibar.build'),
  automate: t('aurora.omnibar.automate'),
}))

const intentMode = computed(() => {
  if (chatStore.isStreaming) return 'processing'
  if (trimmedIntent.value.startsWith('/')) return 'command'
  if (isBuildMode.value) return 'build'
  if (isAutomateMode.value) return 'automate'
  if (attachments.value.length > 0) return 'context'
  return 'ask'
})

const intentModeLabel = computed(() => {
  if (intentMode.value === 'processing') return t('aurora.omnibar.processing')
  if (intentMode.value === 'command') return t('aurora.omnibar.command')
  if (intentMode.value === 'build') return t('aurora.omnibar.build')
  if (intentMode.value === 'automate') return t('aurora.omnibar.automate')
  if (intentMode.value === 'context') return t('aurora.omnibar.context')
  return t('aurora.omnibar.ask')
})

const intentPreview = computed(() => {
  if (trimmedIntent.value) {
    return trimmedIntent.value.length > 88
      ? `${trimmedIntent.value.slice(0, 88)}...`
      : trimmedIntent.value
  }
  if (attachments.value.length > 0) {
    return t('aurora.omnibar.attachment', { count: attachments.value.length })
  }
  if (isBuildMode.value) return t('aurora.omnibar.buildPreview')
  if (isAutomateMode.value) return t('aurora.omnibar.automatePreview')
  return chatStore.activeSession?.title || t('aurora.omnibar.newIntent')
})

type SlashTargetKind = 'Command' | 'Skill' | 'Plugin'

interface SlashTarget {
  id: string
  label: string
  insertText: string
  kind: SlashTargetKind
  description: string
  meta?: string
}

const bridgeCommands = computed(() => [
  { name: 'usage', args: '', description: t('chat.slashCommands.usage') },
  { name: 'status', args: '', description: t('chat.slashCommands.status') },
  { name: 'abort', args: '', description: t('chat.slashCommands.abort') },
  { name: 'queue', args: t('chat.slashCommandArgs.message'), description: t('chat.slashCommands.queue') },
  { name: 'clear', args: '', description: t('chat.slashCommands.clear') },
  { name: 'clear', args: '--history', insertText: 'clear --history', description: t('chat.slashCommands.clearHistory') },
  { name: 'title', args: t('chat.slashCommandArgs.title'), description: t('chat.slashCommands.title') },
  { name: 'compress', args: '', description: t('chat.slashCommands.compress') },
  { name: 'steer', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.steer') },
  { name: 'destroy', args: '', description: t('chat.slashCommands.destroy') },
])

const slashActive = ref(false)
const slashQuery = ref('')
const slashActiveIndex = ref(0)
const historyPaletteOpen = ref(false)
const historyPaletteIndex = ref(0)
const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionActiveIndex = ref(0)
const slashQuickSelectLoaded = ref(false)
const slashQuickSelectLoading = ref(false)
const slashQuickSelectError = ref('')
const skillSlashTargets = ref<SlashTarget[]>([])
const pluginSlashTargets = ref<SlashTarget[]>([])
const isBridgeSession = computed(() => chatStore.activeSession?.source === 'cli')
const bridgeSlashTargets = computed<SlashTarget[]>(() =>
  isBridgeSession.value
    ? bridgeCommands.value.map(command => ({
        id: `command:${command.insertText || command.name}`,
        label: `/${command.name}`,
        insertText: command.insertText || command.name,
        kind: 'Command',
        description: command.description,
        meta: command.args,
      }))
    : [],
)
const slashTargets = computed(() => [
  ...bridgeSlashTargets.value,
  ...skillSlashTargets.value,
  ...pluginSlashTargets.value,
])
const filteredSlashTargets = computed(() => {
  const query = slashQuery.value.toLowerCase()
  return slashTargets.value.filter(target =>
    target.label.toLowerCase().includes(query) ||
    target.insertText.toLowerCase().includes(query) ||
    target.description.toLowerCase().includes(query) ||
    target.kind.toLowerCase().includes(query) ||
    target.meta?.toLowerCase().includes(query),
  )
})
const recentSessions = computed(() =>
  [...chatStore.sessions]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8),
)
const mentionTargets = computed(() => [
  {
    id: 'commander',
    label: 'Commander',
    handle: '@commander',
    kind: t('aurora.omnibar.agent'),
    description: t('aurora.omnibar.commanderDesc'),
  },
  {
    id: 'quant',
    label: 'Quant Lab',
    handle: '@quant',
    kind: t('aurora.omnibar.agent'),
    description: t('aurora.omnibar.quantDesc'),
  },
  {
    id: 'lifeos',
    label: 'LifeOS',
    handle: '@lifeos',
    kind: t('aurora.omnibar.agent'),
    description: t('aurora.omnibar.lifeosDesc'),
  },
  {
    id: 'memory',
    label: 'Memory',
    handle: '@memory',
    kind: t('aurora.omnibar.agent'),
    description: t('aurora.omnibar.memoryDesc'),
  },
  {
    id: 'kanban',
    label: 'Kanban',
    handle: '@kanban',
    kind: t('aurora.omnibar.agent'),
    description: t('aurora.omnibar.kanbanDesc'),
  },
  {
    id: 'group-chat',
    label: 'Group Chat',
    handle: '@group',
    kind: t('aurora.omnibar.channel'),
    description: t('aurora.omnibar.groupDesc'),
  },
])
const filteredMentionTargets = computed(() => {
  const query = mentionQuery.value.toLowerCase()
  if (!query) return mentionTargets.value
  return mentionTargets.value.filter(target =>
    target.label.toLowerCase().includes(query) ||
    target.handle.toLowerCase().includes(query) ||
    target.kind.toLowerCase().includes(query),
  )
})

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

// 从 localStorage 读取设置
onMounted(() => {
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

const isVibeBlocking = computed(() =>
  vibeCodingStore.isVisible && vibeCodingStore.status !== 'idle',
)

const isAuroraBlocking = computed(() =>
  auroraCommanderStore.isRunning || isVibeBlocking.value,
)

const canSend = computed(() => {
  if (isAuroraBlocking.value) return false
  return isBuildMode.value
    ? trimmedIntent.value.length > 0
    : trimmedIntent.value.length > 0 || attachments.value.length > 0
})

const sendLabel = computed(() =>
  isAuroraBlocking.value
    ? t('aurora.omnibar.working')
    : isBuildMode.value && !trimmedIntent.value.startsWith('/') ? t('aurora.omnibar.build')
      : isAutomateMode.value && !trimmedIntent.value.startsWith('/') ? t('aurora.omnibar.automate')
        : t('chat.send'),
)

function setComposerMode(mode: ComposerMode) {
  dismissTransientAuroraCard()
  composerMode.value = mode
  nextTick(() => textareaRef.value?.focus())
}

function dismissTransientAuroraCard() {
  if (auroraCommanderStore.pendingApproval) return
  if (auroraCommanderStore.isRunning || auroraCommanderStore.result || auroraCommanderStore.error) {
    auroraCommanderStore.clear()
  }
}

function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function skillToSlashTarget(category: string, skill: SkillInfo): SlashTarget | null {
  if (skill.enabled === false || skill.source === 'hub') return null
  return {
    id: `skill:${category}:${skill.name}`,
    label: `/skill:${skill.name}`,
    insertText: `skill:${skill.name}`,
    kind: 'Skill',
    description: skill.description || t('aurora.omnibar.useSkillContext'),
    meta: category,
  }
}

function pluginToSlashTarget(plugin: HermesPluginInfo): SlashTarget | null {
  if (!['enabled', 'auto-active', 'provider-managed'].includes(plugin.effectiveStatus)) return null
  return {
    id: `plugin:${plugin.key}`,
    label: `/plugin:${plugin.key}`,
    insertText: `plugin:${plugin.key}`,
    kind: 'Plugin',
    description: plugin.description || plugin.name || t('aurora.omnibar.usePluginContext'),
    meta: plugin.kind || plugin.source,
  }
}

async function loadSlashQuickSelectTargets() {
  if (slashQuickSelectLoaded.value || slashQuickSelectLoading.value) return
  slashQuickSelectLoading.value = true
  slashQuickSelectError.value = ''

  const [skillsResult, pluginsResult] = await Promise.allSettled([
    fetchSkills(),
    fetchPlugins(),
  ])

  if (skillsResult.status === 'fulfilled') {
    skillSlashTargets.value = skillsResult.value.categories
      .flatMap(category =>
        category.skills
          .map(skill => skillToSlashTarget(category.name, skill))
          .filter((target): target is SlashTarget => target !== null),
      )
      .slice(0, 18)
  }

  if (pluginsResult.status === 'fulfilled') {
    pluginSlashTargets.value = pluginsResult.value.plugins
      .map(pluginToSlashTarget)
      .filter((target): target is SlashTarget => target !== null)
      .slice(0, 12)
  }

  slashQuickSelectLoaded.value = true
  slashQuickSelectLoading.value = false

  if (skillsResult.status === 'rejected' || pluginsResult.status === 'rejected') {
    slashQuickSelectError.value = t('aurora.omnibar.slashLoadError')
  }
}

function closeCommandPalettes() {
  historyPaletteOpen.value = false
  mentionActive.value = false
}

function formatSessionTime(timestamp?: number): string {
  if (!timestamp) return t('aurora.omnibar.recent')
  return new Intl.DateTimeFormat(activeLocale.value.toLowerCase().startsWith('en') ? 'en-US' : activeLocale.value, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function openHistoryPalette() {
  slashActive.value = false
  mentionActive.value = false
  historyPaletteIndex.value = 0
  historyPaletteOpen.value = true
  nextTick(() => textareaRef.value?.focus())
}

async function selectHistorySession(index = historyPaletteIndex.value) {
  const session = recentSessions.value[index]
  if (!session) return
  historyPaletteOpen.value = false
  inputText.value = ''
  await chatStore.switchSession(session.id)
  emit('submitted')
}

function updateSlashState() {
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
  slashActive.value = true
  void loadSlashQuickSelectTargets()
  if (slashActive.value) closeCommandPalettes()
}

function selectSlashTarget(target: SlashTarget) {
  inputText.value = `/${target.insertText} `
  slashActive.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

function getMentionTrigger() {
  const el = textareaRef.value
  if (!el) return null
  const cursorPos = el.selectionStart
  const beforeCursor = inputText.value.slice(0, cursorPos)
  const match = beforeCursor.match(/(^|\s)@([\w-]*)$/)
  if (!match) return null
  return {
    start: cursorPos - match[2].length - 1,
    end: cursorPos,
    query: match[2],
  }
}

function updateMentionState() {
  const trigger = getMentionTrigger()
  if (!trigger) {
    mentionActive.value = false
    return
  }
  slashActive.value = false
  historyPaletteOpen.value = false
  mentionQuery.value = trigger.query
  mentionActiveIndex.value = Math.min(mentionActiveIndex.value, Math.max(filteredMentionTargets.value.length - 1, 0))
  mentionActive.value = filteredMentionTargets.value.length > 0
}

function selectMentionTarget(index = mentionActiveIndex.value) {
  const target = filteredMentionTargets.value[index]
  const trigger = getMentionTrigger()
  if (!target || !trigger) return
  inputText.value = `${inputText.value.slice(0, trigger.start)}${target.handle} ${inputText.value.slice(trigger.end)}`
  mentionActive.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = trigger.start + target.handle.length + 1
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

function syncInputFromTextarea() {
  const rawValue = textareaRef.value?.value
  if (typeof rawValue === 'string' && rawValue !== inputText.value) {
    inputText.value = rawValue
  }
}

// --- Context info ---

const contextLength = ref(200000)
const FALLBACK_CONTEXT = 200000

// Context length editing
const showContextEditModal = ref(false)
const editingContextLimit = ref(200000)
const isSavingContextLimit = ref(false)

async function handleEditContextLimit() {
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
    const provider = chatStore.activeSession?.provider || useAppStore().selectedProvider || ''
    const model = chatStore.activeSession?.model || useAppStore().selectedModel || ''

    if (!provider || !model) {
      message.error(t('chat.contextEditFailed'))
      return
    }

    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    showContextEditModal.value = false
    message.success(t('chat.contextEditSuccess'))
  } catch (err: any) {
    message.error(`${t('chat.contextEditFailed')}: ${err.message || ''}`)
  } finally {
    isSavingContextLimit.value = false
  }
}

async function loadContextLength() {
  try {
    const activeSession = chatStore.activeSession
    const profile = activeSession?.profile || useProfilesStore().activeProfileName || undefined
    contextLength.value = await fetchContextLength(
      profile,
      activeSession?.provider || undefined,
      activeSession?.model || undefined,
    )
  } catch {
    contextLength.value = FALLBACK_CONTEXT
  }
}

onMounted(loadContextLength)
watch(() => useProfilesStore().activeProfileName, loadContextLength)
watch(() => useAppStore().selectedProvider, loadContextLength)
watch(() => useAppStore().selectedModel, loadContextLength)
watch(() => chatStore.activeSession?.id, loadContextLength)
watch(() => chatStore.activeSession?.profile, loadContextLength)
watch(() => chatStore.activeSession?.provider, loadContextLength)
watch(() => chatStore.activeSession?.model, loadContextLength)

const totalTokens = computed(() => {
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))
const commandPaletteShortcut = computed(() =>
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K',
)

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

function handleAttachClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of input.files) addFile(file)
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
    addFile(file)
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
  for (const file of files) addFile(file)
  textareaRef.value?.focus()
}

// --- Send ---

async function handleSend() {
  syncInputFromTextarea()
  const text = inputText.value.trim()
  if (isAuroraBlocking.value) return
  if (!text && attachments.value.length === 0) return

  const auroraToolInput = text ? getAuroraToolCommandInput(text) : null

  if (auroraToolInput) {
    const handledByAurora = await auroraCommanderStore.routeInput(auroraToolInput)
    if (handledByAurora) {
      inputText.value = ''
      attachments.value = []
      slashActive.value = false
      closeCommandPalettes()
      emit('submitted')

      if (textareaRef.value) {
        textareaRef.value.style.height = 'auto'
      }
      return
    }
    auroraCommanderStore.clearPassiveResult()
  }

  if (isBuildMode.value && text && !text.startsWith('/') && !auroraToolInput) {
    vibeCodingStore.start(text)
    inputText.value = ''
    slashActive.value = false
    closeCommandPalettes()
    emit('submitted')

    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto'
    }
    return
  }

  if (!isBuildMode.value && text && attachments.value.length === 0 && !text.startsWith('/') && !auroraToolInput) {
    auroraCommanderStore.clearPassiveResult()
  }

  const fallbackText = auroraToolInput || text
  const hermesText = fallbackText ? workingMemoryStore.enrichPrompt(fallbackText) : fallbackText
  chatStore.sendMessage(hermesText, attachments.value.length > 0 ? attachments.value : undefined)
  inputText.value = ''
  attachments.value = []
  slashActive.value = false
  closeCommandPalettes()
  emit('submitted')

  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateSlashState()
    updateMentionState()
  })
}

function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

function handleKeydown(e: KeyboardEvent) {
  if (historyPaletteOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      historyPaletteIndex.value = (historyPaletteIndex.value + 1) % Math.max(recentSessions.value.length, 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      historyPaletteIndex.value = (historyPaletteIndex.value - 1 + Math.max(recentSessions.value.length, 1)) % Math.max(recentSessions.value.length, 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void selectHistorySession()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      historyPaletteOpen.value = false
      return
    }
  }

  if (mentionActive.value && filteredMentionTargets.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % filteredMentionTargets.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + filteredMentionTargets.value.length) % filteredMentionTargets.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectMentionTarget()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      mentionActive.value = false
      return
    }
  }

  if (slashActive.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value + 1) % Math.max(filteredSlashTargets.value.length, 1)
      scrollCommandIntoView()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value - 1 + Math.max(filteredSlashTargets.value.length, 1)) % Math.max(filteredSlashTargets.value.length, 1)
      scrollCommandIntoView()
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && filteredSlashTargets.value.length > 0) {
      e.preventDefault()
      selectSlashTarget(filteredSlashTargets.value[slashActiveIndex.value])
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
  if (el.value.trim()) dismissTransientAuroraCard()
  if (!isComposing.value) {
    updateSlashState()
    updateMentionState()
  }
  // 用户手动拖拽自定义高度时，不覆盖
  if (textareaHeight.value !== null) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function handleCommandHover(index: number) {
  slashActiveIndex.value = index
}

function onDocumentMousedown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('.slash-command-dropdown') && !target.closest('.input-wrapper')) {
    slashActive.value = false
    closeCommandPalettes()
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
  e.preventDefault()
  openHistoryPalette()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
  document.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('keydown', onGlobalKeydown)
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
  <div
    class="chat-input-area"
    :class="{ 'intent-launcher-input': launcher }"
  >
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

      <div
        class="omni-mode-switch"
        role="tablist"
        :aria-label="t('aurora.omnibar.modeLabel')"
      >
        <button
          type="button"
          class="omni-mode-button"
          :class="{ active: composerMode === 'intent' }"
          role="tab"
          :aria-selected="composerMode === 'intent'"
          @click="setComposerMode('intent')"
        >
          {{ composerModeLabels.intent }}
        </button>
        <button
          type="button"
          class="omni-mode-button"
          :class="{ active: composerMode === 'build' }"
          role="tab"
          :aria-selected="composerMode === 'build'"
          @click="setComposerMode('build')"
        >
          {{ composerModeLabels.build }}
        </button>
        <button
          type="button"
          class="omni-mode-button"
          :class="{ active: composerMode === 'automate' }"
          role="tab"
          :aria-selected="composerMode === 'automate'"
          @click="setComposerMode('automate')"
        >
          {{ composerModeLabels.automate }}
        </button>
      </div>

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

      <span v-if="quantContextHint" class="quant-context-hint">
        <span class="quant-context-dot" />
        {{ quantContextHint }}
      </span>

      <span v-if="workingMemoryStore.hasContextLock && workingMemoryHint" class="working-memory-hint">
        <span class="working-memory-dot" />
        Context · {{ workingMemoryHint }}
      </span>

      <span v-if="totalTokens > 0" class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
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
      <div v-if="totalTokens > 0" class="context-bar">
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
      <span v-if="launcher" class="launcher-sparkle" aria-hidden="true">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
        </svg>
      </span>
      <div class="intent-composer">
        <div class="intent-strip">
          <span class="intent-mode" :class="intentMode">
            <span class="intent-mode-dot" aria-hidden="true"></span>
            {{ intentModeLabel }}
          </span>
          <span class="intent-preview">{{ intentPreview }}</span>
        </div>
        <textarea
          ref="textareaRef"
          v-model="inputText"
          class="input-textarea"
          :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
          :placeholder="launcher ? t('aurora.omnibar.placeholder') : t('chat.inputPlaceholder')"
          rows="1"
          @keydown="handleKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
          @input="handleInput"
          @focus="dismissTransientAuroraCard"
          @paste="handlePaste"
        ></textarea>
      </div>
      <Transition name="dropdown-fade">
        <div
          v-if="historyPaletteOpen"
          class="omni-command-palette history-palette"
          :aria-label="t('aurora.omnibar.historyPalette')"
        >
          <div class="palette-header">
            <span>{{ t('aurora.omnibar.historyTitle') }}</span>
            <kbd>{{ commandPaletteShortcut }}</kbd>
          </div>
          <button
            v-for="(session, i) in recentSessions"
            :key="session.id"
            class="palette-item"
            :class="{ active: i === historyPaletteIndex }"
            type="button"
            @mousedown.prevent="selectHistorySession(i)"
            @mouseenter="historyPaletteIndex = i"
          >
            <span class="palette-item-title">{{ session.title || t('aurora.omnibar.untitledIntent') }}</span>
            <span class="palette-item-meta">{{ session.source || 'api' }} · {{ formatSessionTime(session.updatedAt || session.createdAt) }}</span>
          </button>
          <p v-if="recentSessions.length === 0" class="palette-empty">
            {{ t('aurora.omnibar.noRecentChats') }}
          </p>
        </div>
      </Transition>

      <Transition name="dropdown-fade">
        <div
          v-if="mentionActive && filteredMentionTargets.length > 0"
          class="omni-command-palette mention-palette"
          :aria-label="t('aurora.omnibar.summonPalette')"
        >
          <div class="palette-header">
            <span>{{ t('aurora.omnibar.summon') }}</span>
            <kbd>@</kbd>
          </div>
          <button
            v-for="(target, i) in filteredMentionTargets"
            :key="target.id"
            class="palette-item"
            :class="{ active: i === mentionActiveIndex }"
            type="button"
            @mousedown.prevent="selectMentionTarget(i)"
            @mouseenter="mentionActiveIndex = i"
          >
            <span class="palette-item-title">{{ target.handle }} {{ target.label }}</span>
            <span class="palette-item-meta">{{ target.kind }} · {{ target.description }}</span>
          </button>
        </div>
      </Transition>

      <Transition name="dropdown-fade">
        <div
          v-if="slashActive"
          ref="commandDropdownRef"
          class="omni-command-palette slash-command-dropdown"
          :aria-label="t('aurora.omnibar.skillsPalette')"
        >
          <div class="palette-header">
            <span>{{ t('aurora.omnibar.skillsTitle') }}</span>
            <kbd>/</kbd>
          </div>
          <button
            v-for="(target, i) in filteredSlashTargets"
            :key="target.id"
            type="button"
            class="palette-item slash-command-item"
            :class="{ active: i === slashActiveIndex }"
            @mousedown.prevent="selectSlashTarget(target)"
            @mouseenter="handleCommandHover(i)"
          >
            <span class="palette-item-title slash-command-name">{{ target.label }}</span>
            <span class="palette-item-meta">
              <span class="slash-command-kind">{{ target.kind }}</span>
              <span v-if="target.meta"> · {{ target.meta }}</span>
              <span> · {{ target.description }}</span>
            </span>
          </button>
          <p v-if="slashQuickSelectLoading" class="palette-empty">
            {{ t('aurora.omnibar.loadingSkills') }}
          </p>
          <p v-else-if="slashQuickSelectError" class="palette-empty">
            {{ slashQuickSelectError }}
          </p>
          <p v-else-if="filteredSlashTargets.length === 0" class="palette-empty">
            {{ t('aurora.omnibar.noMatchingSkills') }}
          </p>
        </div>
      </Transition>
      <div class="input-actions">
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
            <svg v-if="launcher" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </template>
          <span class="send-label">{{ sendLabel }}</span>
        </NButton>
      </div>
    </div>

    <div
      v-if="launcher"
      class="launcher-mode-switch"
      role="tablist"
      :aria-label="t('aurora.omnibar.auroraModeLabel')"
    >
      <button
        type="button"
        class="launcher-mode-button"
        :class="{ active: composerMode === 'intent' }"
        role="tab"
        :aria-selected="composerMode === 'intent'"
        @click="setComposerMode('intent')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 1 1 18-5z" />
        </svg>
        {{ composerModeLabels.intent }}
      </button>
      <button
        type="button"
        class="launcher-mode-button"
        :class="{ active: composerMode === 'build' }"
        role="tab"
        :aria-selected="composerMode === 'build'"
        @click="setComposerMode('build')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="M4.5 7.8 12 12l7.5-4.2" />
          <path d="M12 12v8" />
        </svg>
        {{ composerModeLabels.build }}
      </button>
      <button
        type="button"
        class="launcher-mode-button"
        :class="{ active: composerMode === 'automate' }"
        role="tab"
        :aria-selected="composerMode === 'automate'"
        @click="setComposerMode('automate')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2 4 14h7l-1 8 10-13h-7z" />
        </svg>
        {{ composerModeLabels.automate }}
      </button>
    </div>

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
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);

  &.intent-launcher-input {
    display: grid;
    gap: 16px;
    width: min(860px, calc(100vw - 420px));
    min-width: min(620px, calc(100vw - 48px));
    max-width: 860px;
    padding: 0;
    border-top: 0;
  }
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
  flex-wrap: wrap;
}

.omni-mode-switch {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(58px, 1fr));
  overflow: hidden;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
}

.intent-launcher-input .input-top-bar {
  display: none;
}

.omni-mode-button {
  min-width: 0;
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 0;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.11);
  }
}

:global(.dark) .omni-mode-switch {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
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

.context-info {
  font-size: 11px;
  color: $text-muted;

  &.context-warning {
    color: #e8a735;
  }
}

.quant-context-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(360px, 45vw);
  padding: 2px 8px;
  border: 1px solid rgba(0, 255, 157, 0.28);
  background: rgba(0, 255, 157, 0.06);
  color: #00ff9d;
  font-family: $font-code;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 0 12px rgba(0, 255, 157, 0.08);
}

.quant-context-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 50%;
  background: #00ff9d;
  box-shadow: 0 0 8px rgba(0, 255, 157, 0.9);
}

.working-memory-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(320px, 42vw);
  padding: 2px 8px;
  border: 1px solid rgba(129, 140, 248, 0.22);
  border-radius: 999px;
  color: rgba(99, 102, 241, 0.88);
  background: rgba(129, 140, 248, 0.08);
  font-family: $font-code;
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: 0 0 12px rgba(129, 140, 248, 0.08);
}

.working-memory-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 50%;
  background: #818cf8;
  box-shadow: 0 0 10px rgba(129, 140, 248, 0.82);
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
  align-items: flex-end;
  gap: 10px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.46)),
    $bg-input;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
  border-radius: 18px;
  padding: 9px 12px 10px;
  position: relative;
  box-shadow:
    0 10px 30px rgba(72, 98, 138, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(18px);
  transition: border-color $transition-fast, background-color $transition-fast, box-shadow $transition-fast;

  &:focus-within {
    border-color: $accent-primary;
    box-shadow:
      0 12px 34px rgba(var(--accent-primary-rgb), 0.12),
      0 0 0 3px rgba(var(--accent-primary-rgb), 0.06),
      inset 0 1px 0 rgba(255, 255, 255, 0.7);
  }

  .dark & {
    background:
      linear-gradient(135deg, rgba(42, 48, 60, 0.88), rgba(32, 36, 45, 0.72)),
      #333333;
  }
}

.intent-launcher-input .input-wrapper {
  align-items: center;
  gap: 12px;
  min-height: 60px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 999px;
  padding: 8px 10px 8px 20px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.06);
  box-shadow:
    0 8px 32px rgba(139, 92, 246, 0.08),
    0 24px 70px rgba(81, 87, 143, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.42);
  backdrop-filter: blur(34px);

  &:focus-within {
    border-color: rgba(151, 125, 255, 0.45);
    box-shadow:
      0 8px 32px rgba(31, 38, 135, 0.08),
      0 32px 100px rgba(126, 105, 255, 0.2),
      0 0 0 5px rgba(135, 108, 255, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.72);
  }
}

.launcher-sparkle {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 999px;
  color: #6675ff;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

:global(.dark) .intent-launcher-input .input-wrapper {
  border-color: rgba(255, 255, 255, 0.16);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.055)),
    rgba(17, 21, 31, 0.58);
  box-shadow:
    0 28px 90px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.intent-launcher-input .intent-strip {
  display: none;
}

.intent-launcher-input .input-textarea {
  min-height: 30px;
  max-height: 120px;
  color: rgba(38, 47, 92, 0.82);
  font-size: clamp(16px, 1.65vw, 19px);
  font-weight: 650;
  line-height: 1.45;
}

.intent-launcher-input .input-textarea::placeholder {
  color: rgba(70, 77, 126, 0.44);
}

.intent-launcher-input .input-actions :deep(.n-button) {
  width: 44px;
  min-width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 999px;
  color: #fff;
  background:
    radial-gradient(circle at 31% 24%, rgba(255, 255, 255, 0.86), transparent 24%),
    linear-gradient(135deg, #818cf8 0%, #8b5cf6 58%, #a855f7 100%);
  box-shadow:
    0 14px 30px rgba(116, 89, 255, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.42);
}

.intent-launcher-input .input-actions :deep(.n-button:hover) {
  background:
    radial-gradient(circle at 31% 24%, rgba(255, 255, 255, 0.86), transparent 24%),
    linear-gradient(135deg, #6f7cff 0%, #8150ef 58%, #a855f7 100%);
  box-shadow:
    0 16px 34px rgba(116, 89, 255, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.46);
}

.intent-launcher-input .send-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.launcher-mode-switch {
  display: inline-flex;
  justify-content: center;
  gap: 10px;
  justify-self: center;
}

.launcher-mode-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 94px;
  height: 38px;
  padding: 0 18px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 999px;
  color: rgba(65, 56, 156, 0.78);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.055);
  box-shadow:
    0 8px 22px rgba(139, 92, 246, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(28px);
  cursor: pointer;
  font-size: 13px;
  font-weight: 820;
  line-height: 1;
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
}

.launcher-mode-button svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  stroke-width: 1.7;
}

.launcher-mode-button:hover,
.launcher-mode-button.active {
  color: rgba(56, 47, 146, 0.95);
  border-color: rgba(124, 102, 255, 0.34);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.06)),
    rgba(255, 255, 255, 0.1);
  box-shadow:
    0 14px 30px rgba(126, 105, 255, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.68);
}

.intent-composer {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.intent-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 18px;
}

.intent-mode {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.13);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.06);
  color: $accent-primary;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;

  &.command {
    border-color: rgba(var(--warning-rgb), 0.18);
    background: rgba(var(--warning-rgb), 0.08);
    color: $warning;
  }

  &.context {
    border-color: rgba(0, 255, 157, 0.2);
    background: rgba(0, 255, 157, 0.07);
    color: #00b875;
  }

  &.processing {
    border-color: rgba(43, 209, 255, 0.2);
    background: rgba(43, 209, 255, 0.08);
    color: #169ec7;
  }

  &.build {
    border-color: rgba(255, 115, 172, 0.24);
    background: rgba(255, 115, 172, 0.08);
    color: #bd2f73;
  }

  &.ask,
  &.automate {
    border-color: rgba(121, 99, 255, 0.22);
    background: rgba(121, 99, 255, 0.08);
    color: #7059f7;
  }
}

.intent-mode-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 10px currentColor;
}

.intent-preview {
  min-width: 0;
  overflow: hidden;
  color: $text-muted;
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  min-height: 20px;
  overflow-y: auto;

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

.omni-command-palette {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 10px);
  z-index: 30;
  display: grid;
  gap: 5px;
  max-height: min(360px, 52vh);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.44);
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.52)),
    rgba(255, 255, 255, 0.68);
  box-shadow:
    0 18px 46px rgba(66, 84, 117, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(16px);
}

.palette-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 28px;
  padding: 0 7px 4px;
  color: rgba(24, 32, 51, 0.48);
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.palette-header kbd {
  min-width: 38px;
  padding: 4px 7px;
  border: 1px solid rgba(121, 99, 255, 0.14);
  border-radius: 8px;
  color: #7059f7;
  background: rgba(121, 99, 255, 0.08);
  font-family: $font-ui;
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
  text-align: center;
}

.palette-item {
  display: grid;
  gap: 4px;
  min-height: 52px;
  padding: 9px 10px;
  border: 0;
  border-radius: 13px;
  color: rgba(24, 32, 51, 0.72);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.palette-item.active,
.palette-item:hover {
  color: #6150dc;
  background: rgba(121, 99, 255, 0.1);
}

.palette-item-title,
.palette-item-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-item-title {
  font-size: 13px;
  font-weight: 900;
  line-height: 1.15;
}

.palette-item-meta {
  color: rgba(24, 32, 51, 0.48);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
}

.palette-empty {
  margin: 0;
  padding: 14px 10px;
  color: rgba(24, 32, 51, 0.48);
  font-size: 12px;
  font-weight: 750;
}

:global(.dark) .omni-command-palette {
  border-color: rgba(255, 255, 255, 0.12);
  background:
    linear-gradient(135deg, rgba(31, 37, 50, 0.9), rgba(20, 24, 34, 0.78)),
    rgba(18, 22, 32, 0.82);
}

:global(.dark) .palette-header,
:global(.dark) .palette-item-meta,
:global(.dark) .palette-empty {
  color: rgba(237, 243, 255, 0.52);
}

:global(.dark) .palette-item {
  color: rgba(237, 243, 255, 0.76);
}

:global(.dark) .palette-item.active,
:global(.dark) .palette-item:hover {
  color: #9de9ff;
  background: rgba(43, 209, 255, 0.1);
}

.slash-command-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
  gap: 4px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 13px;
  cursor: pointer;
  min-height: 52px;

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

.slash-command-kind {
  color: #7059f7;
  font-weight: 900;
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

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
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
