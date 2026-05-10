import { ref, computed, onUnmounted } from 'vue'
import { generateSpeech, playAudioBlob } from '@/api/hermes/tts'

export interface SpeechOptions {
  lang?: string      // 语言 'zh-CN', 'en-US' 等
  voiceName?: string // 指定 WebSpeech 音色名称
}

export interface OpenaiTtsOptions {
  baseUrl: string
  apiKey?: string
  model?: string
  voice?: string
}

export interface SpeechState {
  isPlaying: boolean
  isPaused: boolean
  currentMessageId: string | null
  progress: number  // 当前进度（字符数）
  engine: 'none' | 'tts' | 'browser'  // 当前使用的引擎
}

interface SpeechQueueItem {
  messageId: string
  content: string
  options: SpeechOptions
}

/**
 * 语音播放 Composable
 * 优先后端 TTS（Edge → Google），失败降级浏览器 speechSynthesis
 */
export function useSpeech() {
  const synth = window.speechSynthesis
  const availableVoices = ref<SpeechSynthesisVoice[]>([])
  const state = ref<SpeechState>({
    isPlaying: false,
    isPaused: false,
    currentMessageId: null,
    progress: 0,
    engine: 'none',
  })

  let utterance: SpeechSynthesisUtterance | null = null
  let currentAudio: HTMLAudioElement | null = null
  let playbackToken = 0
  const speechQueue: SpeechQueueItem[] = []

  // 自定义 TTS（OpenAI / Custom / Edge）播放状态
  const isCustomPlaying = ref(false)
  const isCustomPaused = ref(false)
  const currentCustomMessageId = ref<string | null>(null)

  // 加载可用语音列表
  function loadVoices() {
    availableVoices.value = synth.getVoices()
  }

  synth.addEventListener('voiceschanged', loadVoices)
  loadVoices()

  /**
   * 从文本中提取纯文本内容，过滤代码块、thinking 标签等
   */
  function extractReadableText(content: string): string {
    if (!content) return ''

    let text = content

    // 移除 thinking 标签内容
    text = text.replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
    text = text.replace(/<thinking[^>]*>[\s\S]*/gi, '')

    // 移除代码块
    text = text.replace(/```[\s\S]*?```/g, '')
    text = text.replace(/`[^`]+`/g, '')

    // 移除 HTML 标签
    text = text.replace(/<[^>]+>/g, '')

    text = text.replace(/[^\p{L}\p{N}\s。!?;,，。！？；：、""''（）【】《》\n一-鿿㐀-䶿]/gu, '')

    text = text.replace(/\s+/g, ' ').trim()

    return text
  }

  const isSupported = computed(() => {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  })

  function getDefaultVoice(): SpeechSynthesisVoice | null {
    const voices = availableVoices.value
    if (voices.length === 0) return null

    const zhVoice = voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) return zhVoice

    const enVoice = voices.find(v => v.lang.startsWith('en'))
    if (enVoice) return enVoice

    return voices[0]
  }

  function stop(clearQueue = true) {
    playbackToken += 1
    if (clearQueue) {
      speechQueue.length = 0
    }
    // Stop TTS audio
    if (currentAudio) {
      currentAudio.pause()
      currentAudio.src = ''
      currentAudio = null
    }
    // Stop browser speech
    if (synth.speaking || synth.pending || synth.paused) {
      synth.cancel()
    }
    utterance = null
    state.value = {
      isPlaying: false,
      isPaused: false,
      currentMessageId: null,
      progress: 0,
      engine: 'none',
    }
  }

  // ─── TTS Engine (server-side) ───────────────────────────────

  async function speakViaTts(messageId: string, text: string, options: SpeechOptions, token: number) {
    // Set playing state immediately so UI shows breathing animation right away
    state.value.isPlaying = true
    state.value.isPaused = false
    state.value.currentMessageId = messageId
    state.value.progress = 0
    state.value.engine = 'tts'

    try {
      const lang = options.lang || 'zh-CN'

      const { audio } = await generateSpeech({ text, lang })

      if (token !== playbackToken) return

      currentAudio = playAudioBlob(audio)

      currentAudio.onended = () => {
        if (token !== playbackToken) return
        state.value.isPlaying = false
        state.value.isPaused = false
        state.value.currentMessageId = null
        state.value.progress = text.length
        state.value.engine = 'none'
        currentAudio = null
        if (speechQueue.length > 0) {
          setTimeout(playNextQueuedSpeech, 0)
        }
      }

      currentAudio.onerror = () => {
        if (token !== playbackToken) return
        // TTS playback failed, fallback to browser
        console.warn('[useSpeech] TTS audio playback error, falling back to browser')
        speakViaBrowser(messageId, text, options, token)
      }
    } catch (err) {
      if (token !== playbackToken) return
      console.warn('[useSpeech] TTS API failed, falling back to browser:', err)
      speakViaBrowser(messageId, text, options, token)
    }
  }

  // ─── Browser Engine (Web Speech API) ────────────────────────

  function speakViaBrowser(messageId: string, text: string, options: SpeechOptions, token?: number) {
    token = token || ++playbackToken
    utterance = new SpeechSynthesisUtterance(text)
    const activeUtterance = utterance

    utterance.rate = 1
    utterance.pitch = 1
    utterance.volume = 1

    // 使用指定的音色（如果有），否则用默认
    if (options.voiceName) {
      const voice = availableVoices.value.find(v => v.name === options.voiceName)
      if (voice) {
        utterance.voice = voice
      }
    }
    if (!utterance.voice) {
      utterance.voice = getDefaultVoice()
    }

    if (options.lang) {
      utterance.lang = options.lang
    } else if (utterance.voice) {
      utterance.lang = utterance.voice.lang
    }

    state.value.engine = 'browser'
    state.value.isPlaying = true
    state.value.isPaused = false
    state.value.currentMessageId = messageId
    state.value.progress = 0

    utterance.onboundary = (event) => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      if (event.name === 'word') {
        state.value.progress = event.charIndex
      }
    }

    utterance.onend = () => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
      state.value.progress = text.length
      state.value.engine = 'none'
      utterance = null
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
    }

    utterance.onerror = () => {
      if (token !== playbackToken || utterance !== activeUtterance) return
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
      state.value.engine = 'none'
      utterance = null
      if (speechQueue.length > 0) {
        setTimeout(playNextQueuedSpeech, 0)
      }
    }

    synth.speak(utterance)
  }

  // ─── OpenAI-compatible TTS Engine ────────────────────────────

  let customAudio: HTMLAudioElement | null = null

  async function openaiPlay(
    messageId: string,
    content: string,
    opts: OpenaiTtsOptions,
  ) {
    const text = extractReadableText(content)
    if (!text) return

    const token = ++playbackToken

    isCustomPlaying.value = true
    isCustomPaused.value = false
    currentCustomMessageId.value = messageId

    const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/speech`
    const body: Record<string, any> = {
      model: opts.model || 'tts-1',
      input: text,
      voice: opts.voice || 'alloy',
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (opts.apiKey) {
      headers['Authorization'] = `Bearer ${opts.apiKey}`
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (token !== playbackToken) return

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`OpenAI TTS 返回 ${res.status}: ${errText || res.statusText}`)
      }

      const audioBlob = await res.blob()
      if (token !== playbackToken) return

      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      customAudio = audio

      audio.onended = () => {
        if (token !== playbackToken) return
        URL.revokeObjectURL(audioUrl)
        isCustomPlaying.value = false
        isCustomPaused.value = false
        currentCustomMessageId.value = null
        customAudio = null
      }

      audio.onerror = () => {
        if (token !== playbackToken) return
        URL.revokeObjectURL(audioUrl)
        console.warn('[useSpeech] Custom TTS audio playback error')
        isCustomPlaying.value = false
        isCustomPaused.value = false
        currentCustomMessageId.value = null
        customAudio = null
      }

      await audio.play()
    } catch (err) {
      if (token !== playbackToken) return
      console.error('[useSpeech] OpenAI TTS 请求失败:', err)
      isCustomPlaying.value = false
      isCustomPaused.value = false
      currentCustomMessageId.value = null
      throw err
    }
  }

  function openaiToggle(messageId: string, content: string, opts: OpenaiTtsOptions) {
    if (currentCustomMessageId.value === messageId && isCustomPlaying.value) {
      if (isCustomPaused.value) {
        // Resume
        if (customAudio) {
          customAudio.play()
        }
        isCustomPaused.value = false
      } else {
        // Pause
        if (customAudio) {
          customAudio.pause()
        }
        isCustomPaused.value = true
      }
    } else {
      // Stop other speech and start new
      stop(false)
      if (customAudio) {
        customAudio.pause()
        customAudio = null
      }
      openaiPlay(messageId, content, opts)
    }
  }

  // ─── Unified speak ──────────────────────────────────────────

  function speak(messageId: string, text: string, options: SpeechOptions = {}) {
    const token = ++playbackToken

    // Try server-side TTS first, fallback to browser
    speakViaTts(messageId, text, options, token)
  }

  function playNextQueuedSpeech() {
    if (state.value.isPlaying || state.value.isPaused) return
    const next = speechQueue.shift()
    if (!next) return

    const text = extractReadableText(next.content)
    if (!text) {
      setTimeout(playNextQueuedSpeech, 0)
      return
    }

    speak(next.messageId, text, next.options)
  }

  function play(messageId: string, content: string, options: SpeechOptions = {}) {
    // If playing other message, stop first
    if (state.value.currentMessageId && state.value.currentMessageId !== messageId) {
      stop()
    }

    // Toggle play/pause for same message
    if (state.value.currentMessageId === messageId) {
      if (state.value.isPaused) {
        resume()
      } else if (state.value.isPlaying) {
        pause()
      }
      return
    }

    const text = extractReadableText(content)
    if (!text) return

    stop()
    speak(messageId, text, options)
  }

  function enqueue(messageId: string, content: string, options: SpeechOptions = {}) {
    if (!extractReadableText(content)) return
    speechQueue.push({ messageId, content, options })
    playNextQueuedSpeech()
  }

  function pause() {
    if (state.value.engine === 'tts' && currentAudio) {
      currentAudio.pause()
      state.value.isPaused = true
    } else if (synth.speaking && !state.value.isPaused) {
      synth.pause()
      state.value.isPaused = true
    }
  }

  function resume() {
    if (state.value.isPaused) {
      if (state.value.engine === 'tts' && currentAudio) {
        currentAudio.play()
      } else {
        synth.resume()
      }
      state.value.isPaused = false
    }
  }

  function toggle(messageId: string, content: string, options: SpeechOptions = {}) {
    if (state.value.currentMessageId === messageId && state.value.isPlaying) {
      if (state.value.isPaused) {
        resume()
      } else {
        pause()
      }
    } else {
      play(messageId, content, options)
    }
  }

  onUnmounted(() => {
    stop()
    synth.removeEventListener('voiceschanged', loadVoices)
  })

  return {
    isSupported,
    availableVoices,
    isPlaying: computed(() => state.value.isPlaying),
    isPaused: computed(() => state.value.isPaused),
    currentMessageId: computed(() => state.value.currentMessageId),
    progress: computed(() => state.value.progress),
    engine: computed(() => state.value.engine),

    // Custom TTS state
    isCustomPlaying,
    isCustomPaused,
    currentCustomMessageId,

    play,
    pause,
    resume,
    stop,
    toggle,
    enqueue,
    getDefaultVoice,
    extractReadableText,

    // OpenAI-compatible TTS
    openaiPlay,
    openaiToggle,

    // Browser WebSpeech (直接调用避免 Rolldown 树摇)
    speakViaBrowser,
  }
}

let globalSpeech: ReturnType<typeof useSpeech> | null = null

export function useGlobalSpeech() {
  if (!globalSpeech) {
    globalSpeech = useSpeech()
  }
  return globalSpeech
}
