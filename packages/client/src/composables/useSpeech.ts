import { ref, computed, onUnmounted } from 'vue'

export interface SpeechOptions {
  rate?: number      // 语速 0.1-10，默认 1
  pitch?: number     // 音调 0-2，默认 1
  volume?: number    // 音量 0-1，默认 1
  voice?: SpeechSynthesisVoice | null
  lang?: string      // 语言 'zh-CN', 'en-US' 等
}

export interface SpeechState {
  isPlaying: boolean
  isPaused: boolean
  currentMessageId: string | null
  progress: number  // 当前进度（字符数）
}

/**
 * Web Speech API 语音播放 Composable
 */
export function useSpeech() {
  const synth = window.speechSynthesis
  const availableVoices = ref<SpeechSynthesisVoice[]>([])
  const state = ref<SpeechState>({
    isPlaying: false,
    isPaused: false,
    currentMessageId: null,
    progress: 0,
  })

  let utterance: SpeechSynthesisUtterance | null = null
  let currentText = ''

  // 加载可用语音列表
  function loadVoices() {
    availableVoices.value = synth.getVoices()
  }

  // 浏览器会在语音列表变化时触发 voiceschanged 事件
  synth.addEventListener('voiceschanged', loadVoices)
  loadVoices() // 初始加载

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

    // 只保留：字母、数字、空格、常用标点、中文
    // 保留的标点：。!?;,，。！？；：、""''（）【】《》
    // 移除：*# 等特殊符号、表情符号、emoji 等
    text = text.replace(/[^\p{L}\p{N}\s。!?;,，。！？；：、""''（）【】《》\n一-鿿㐀-䶿]/gu, '')

    // 移除多余的空白
    text = text.replace(/\s+/g, ' ').trim()

    return text
  }

  /**
   * 检查浏览器是否支持 Web Speech API
   */
  const isSupported = computed(() => {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  })

  /**
   * 获取默认语音（优先选择中文）
   */
  function getDefaultVoice(): SpeechSynthesisVoice | null {
    const voices = availableVoices.value
    if (voices.length === 0) return null

    // 优先选择中文语音
    const zhVoice = voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) return zhVoice

    // 其次选择英文语音
    const enVoice = voices.find(v => v.lang.startsWith('en'))
    if (enVoice) return enVoice

    // 默认第一个
    return voices[0]
  }

  /**
   * 获取所有可用语音（用于调试）
   */
  function getAllVoices(): SpeechSynthesisVoice[] {
    return availableVoices.value
  }

  /**
   * 停止当前播放
   */
  function stop() {
    if (synth.speaking) {
      synth.cancel()
    }
    if (utterance) {
      utterance = null
    }
    state.value = {
      isPlaying: false,
      isPaused: false,
      currentMessageId: null,
      progress: 0,
    }
    currentText = ''
  }

  /**
   * 播放文本
   */
  function play(messageId: string, content: string, options: SpeechOptions = {}) {
    if (!isSupported.value) {
      console.warn('[useSpeech] Speech synthesis not supported')
      return
    }

    console.log('[useSpeech] play called:', messageId)

    // 如果正在播放其他消息，先停止
    if (state.value.currentMessageId && state.value.currentMessageId !== messageId) {
      stop()
    }

    // 如果已经在播放这条消息，暂停/恢复
    if (state.value.currentMessageId === messageId) {
      if (state.value.isPaused) {
        resume()
      } else if (state.value.isPlaying) {
        pause()
      }
      return
    }

    // 提取可读文本
    const text = extractReadableText(content)
    if (!text) {
      console.warn('[useSpeech] No readable text found')
      return
    }

    console.log('[useSpeech] Playing text:', text.substring(0, 50) + '...')

    // 停止当前播放
    stop()

    // 创建新的 utterance
    utterance = new SpeechSynthesisUtterance(text)
    currentText = text

    // 设置语音参数
    utterance.rate = options.rate ?? 1
    utterance.pitch = options.pitch ?? 1
    utterance.volume = options.volume ?? 1
    utterance.voice = options.voice ?? getDefaultVoice()

    console.log('[useSpeech] Selected voice:', utterance.voice?.name, utterance.voice?.lang)

    if (options.lang) {
      utterance.lang = options.lang
    } else if (utterance.voice) {
      utterance.lang = utterance.voice.lang
    }

    // 事件监听
    utterance.onstart = () => {
      console.log('[useSpeech] onstart fired')
      state.value.isPlaying = true
      state.value.isPaused = false
      state.value.currentMessageId = messageId
      state.value.progress = 0
    }

    utterance.onboundary = (event) => {
      if (event.name === 'word') {
        state.value.progress = event.charIndex
      }
    }

    utterance.onend = () => {
      console.log('[useSpeech] onend fired')
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
      state.value.progress = currentText.length
    }

    utterance.onerror = (event) => {
      console.error('[useSpeech] Speech synthesis error:', event.error)
      state.value.isPlaying = false
      state.value.isPaused = false
      state.value.currentMessageId = null
    }

    // 开始播放
    console.log('[useSpeech] Calling synth.speak()')
    synth.speak(utterance)
  }

  /**
   * 暂停播放
   */
  function pause() {
    if (synth.speaking && !state.value.isPaused) {
      synth.pause()
      state.value.isPaused = true
    }
  }

  /**
   * 恢复播放
   */
  function resume() {
    if (state.value.isPaused) {
      synth.resume()
      state.value.isPaused = false
    }
  }

  /**
   * 切换播放/暂停
   */
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

  // 清理
  onUnmounted(() => {
    stop()
    synth.removeEventListener('voiceschanged', loadVoices)
  })

  return {
    // 状态
    isSupported,
    availableVoices,
    isPlaying: computed(() => state.value.isPlaying),
    isPaused: computed(() => state.value.isPaused),
    currentMessageId: computed(() => state.value.currentMessageId),
    progress: computed(() => state.value.progress),

    // 方法
    play,
    pause,
    resume,
    stop,
    toggle,
    getDefaultVoice,
    getAllVoices,
    extractReadableText,
  }
}

// 单例模式，全局共享一个语音实例
let globalSpeech: ReturnType<typeof useSpeech> | null = null

export function useGlobalSpeech() {
  if (!globalSpeech) {
    globalSpeech = useSpeech()
  }
  return globalSpeech
}
